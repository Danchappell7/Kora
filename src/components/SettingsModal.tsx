/* ============================================================
   KANBO — Settings: one sectioned sheet.
   Profile · Appearance · Notifications · Calendar & integrations ·
   Workspace (admins) · Billing · Tags · Shortcuts · Data · Account.
   Desktop: 880 × min(760, viewport − 48) with a 200px section list on
   the left (a vertical tablist: ↑/↓/Home/End move and select) and a
   scrolling pane on the right. Phones: full screen; the sections are a
   list and tapping one pushes it, with a Back button.
   Appearance applies instantly; the profile has a Save bar that only
   shows while something has changed. `section` / `onSection` make the
   open section controllable (⌘, · ? → Shortcuts · Manage tags → Tags).
   ============================================================ */
import { useState, useEffect, useRef, useId, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon, Collapse, avatarPaint, Button, IconButton, Toggle, EmptyState } from "./primitives";
import { memberInitials } from "../data/data";
import type { IconName, CalendarConnection, CalProvider, Subscription, TagDef } from "../data/types";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { ACCENTS, accentSwatch, type Appearance, type Density, type TextSize } from "../lib/appearance";
import { AVATAR_ACCEPT, avatarObjectPath, prepareAvatarFile, removeAvatarObjects } from "../lib/avatarUpload";
import { PASSWORD_MIN, passwordIssue, friendlyPasswordError, friendlySignOutError } from "../lib/accountSecurity";
import { SHORTCUTS, type Shortcut } from "../lib/nav";
import { TagManagerPanel } from "./TagManagerModal";
import { BillingPanel } from "./Billing";

const PRONOUN_SUGGESTIONS = ["she/her", "he/him", "they/them", "she/they", "he/they", "ze/zir"];

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  pronouns: string;
  avatarUrl: string | null;
}

export type ThemeChoice = "light" | "dark" | "system";
export type SettingsSection = "profile" | "appearance" | "notifications" | "calendar" | "workspace" | "billing" | "tags" | "shortcuts" | "data" | "account";

const THEMES: { id: ThemeChoice; label: string; icon: IconName }[] = [
  { id: "light", label: "Light", icon: "sun" }, { id: "dark", label: "Dark", icon: "moon" }, { id: "system", label: "System", icon: "settings" },
];
const TEXT_SIZES: { id: TextSize; label: string }[] = [{ id: "small", label: "Small" }, { id: "normal", label: "Normal" }, { id: "large", label: "Large" }];
const DENSITIES: { id: Density; label: string }[] = [{ id: "comfortable", label: "Comfortable" }, { id: "compact", label: "Compact" }];

const NOTIF_ROWS: { key: string; label: string; hint: string }[] = [
  { key: "assigned", label: "Assigned to me", hint: "Someone gives you a task." },
  { key: "mention", label: "Mentions", hint: "Someone @mentions you in a comment." },
  { key: "comment", label: "Comments on my tasks", hint: "New comments on tasks you own or follow." },
  { key: "due", label: "Due-date reminders", hint: "Sent by email only." },
];

const CAL_PROVIDERS: { id: CalProvider; label: string; short: string }[] = [
  { id: "google", label: "Google Calendar", short: "Google Calendar" },
  { id: "microsoft", label: "Microsoft Outlook", short: "Outlook" },
];

/** the sections, in order; `sep` starts a new group in the list */
const SECTIONS: { id: SettingsSection; label: string; icon: IconName; sep?: boolean }[] = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "calendar", label: "Calendar & integrations", icon: "calendar" },
  { id: "workspace", label: "Workspace", icon: "briefcase", sep: true },
  { id: "billing", label: "Billing", icon: "zap", sep: true },
  { id: "tags", label: "Tags", icon: "layers" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard", sep: true },
  { id: "data", label: "Data", icon: "archive" },
  { id: "account", label: "Account", icon: "lock" },
];
/** where an uncontrolled sheet opens: the preferences people reach for most
 *  (the avatar in the sidebar can ask for "profile" instead) */
const DEFAULT_SECTION: SettingsSection = "appearance";
const SHORTCUT_GROUPS: Shortcut["group"][] = ["General", "Create", "Navigate", "Lists", "Today", "Inbox"];

const DELETE_WORD = "DELETE";
// Set in user_metadata once a Google-only account adds a password: Supabase
// doesn't add "email" to app_metadata.providers when it does.
const PASSWORD_SET_FLAG = "kanbo_password_set";
const EXIT_MS = 160;
const SAVED_MS = 2400;

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

export function SettingsModal({ open, onClose, initial, email, color, onUpload, onSave, onExport, onDeleteAccount, notifyPrefs = {}, onSaveNotifyPrefs, appearance, onChangeAppearance, theme, onChangeTheme,
  section, onSection, renderWorkspace, tagsPanel, calendar, billing, onImport, isAdmin, isGuest, onGoPeople, onSignOut }: {
  open: boolean;
  onClose: () => void;
  initial: ProfileDraft;
  email: string;
  color: string;
  onUpload: (file: File) => Promise<string>;
  onSave: (p: ProfileDraft) => Promise<void>;
  onExport: () => void;
  onDeleteAccount: () => Promise<void>;
  notifyPrefs?: Record<string, boolean>;
  onSaveNotifyPrefs?: (prefs: Record<string, boolean>) => void;
  appearance?: Appearance;
  onChangeAppearance?: (a: Appearance) => void;
  /** light, dark, or follow the device ("system"); the choice shows only when both are given */
  theme?: ThemeChoice;
  onChangeTheme?: (t: ThemeChoice) => void;
  /** the open section; controlled when given (the list then asks via onSection) */
  section?: SettingsSection;
  onSection?: (s: SettingsSection) => void;
  /** Settings › Workspace (admins only): the workspace's logo, name and Close workspace */
  renderWorkspace?: () => ReactNode;
  /** Settings › Tags: TagManagerModal's props */
  tagsPanel?: {
    tags: Record<string, TagDef>;
    taskCounts: Record<string, number>;
    onUpdate: (id: string, patch: { label?: string; color?: string }) => void;
    onDelete: (id: string) => void;
    onMerge: (fromId: string, intoId: string) => void;
    onCreate?: (label: string, color: string) => void;
  };
  /** Settings › Calendar & integrations */
  calendar?: { connections: CalendarConnection[]; onConnect: (provider: string) => void; onDisconnect: (id: string) => void; syncing: boolean };
  /** Settings › Billing */
  billing?: { enabled: boolean; subscription: Subscription | null; onUpgrade: () => void; onManageBilling: () => void };
  /** Settings › Data › Import tasks… (Settings closes first, so the import dialog isn't underneath) */
  onImport?: () => void;
  /** shows Workspace (with renderWorkspace) */
  isAdmin?: boolean;
  /** guests: no Workspace; Billing says their admin manages it */
  isGuest?: boolean;
  /** Workspace › "Members & roles →": Settings closes, then this runs (→ Team › People) */
  onGoPeople?: () => void;
  /** Account › Sign out (defaults to the auth provider's own sign-out) */
  onSignOut?: () => void;
}) {
  const auth = useAuth();
  const uid = auth.user?.id ?? null;
  const ids = "kset" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const phone = useMediaQuery("(max-width: 859px)");

  /* ---------- which section ---------- */
  const available = SECTIONS.filter((s) => s.id !== "workspace" || (!!isAdmin && !!renderWorkspace && !isGuest));
  const [inner, setInner] = useState<SettingsSection>(section ?? DEFAULT_SECTION);
  const wanted = section ?? inner;
  const active: SettingsSection = available.some((s) => s.id === wanted) ? wanted : DEFAULT_SECTION;
  const meta = SECTIONS.find((s) => s.id === active)!;
  // phones start on the list unless a section was asked for
  const [pushed, setPushed] = useState(section !== undefined);
  const pick = (s: SettingsSection) => { setInner(s); if (s !== active) onSection?.(s); };

  /* ---------- open / close (with the exit fade) ---------- */
  const [prevOpen, setPrevOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setLeaving(!open && !reducedMotion());
    if (open) { setInner(section ?? DEFAULT_SECTION); setPushed(section !== undefined); }
  }
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  // a prefs pref is ON unless explicitly false (in-app key = base; email key = base+"_email")
  const prefOn = (k: string) => notifyPrefs[k] !== false;
  const togglePref = (k: string) => onSaveNotifyPrefs?.({ ...notifyPrefs, [k]: !prefOn(k) });

  /* ---------- profile draft ---------- */
  // `base` is the profile as last saved: the prop, or what this sheet just saved
  const [base, setBase] = useState<ProfileDraft>(initial);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [pronouns, setPronouns] = useState(initial.pronouns);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initial.avatarUrl);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteWord, setDeleteWord] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // password & sign-in
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwTried, setPwTried] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState<string | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [leavingHere, setLeavingHere] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pwButtonRef = useRef<HTMLButtonElement>(null);
  const focusTimer = useRef(0);   // see focusLater
  const pwInputRef = useRef<HTMLInputElement>(null);
  const pw2InputRef = useRef<HTMLInputElement>(null);
  const signOutButtonRef = useRef<HTMLButtonElement>(null);
  const signOutCancelRef = useRef<HTMLButtonElement>(null);
  const signOutPanelRef = useRef<HTMLDivElement>(null);
  const pwFormRef = useRef<HTMLFormElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const backRef = useRef<HTMLButtonElement>(null);
  const navFocus = useRef<"back" | SettingsSection | null>(null);
  const downOnScrim = useRef(false);
  // photos uploaded while the sheet is open that the profile doesn't point
  // at yet; removed from storage if they end up unused
  const uploadsRef = useRef<string[]>([]);
  // bumps on every open/close so a slow upload or save can tell it was abandoned
  const sessionRef = useRef(0);

  // closing without saving: the profile still points at the saved photo, so
  // anything uploaded in this session is unused
  const discardUploads = () => {
    const unused = uploadsRef.current;
    uploadsRef.current = [];
    if (unused.length) void removeAvatarObjects(unused, uid);
  };
  const dismiss = () => { discardUploads(); onClose(); };
  const trapRef = useFocusTrap<HTMLDivElement>(open, dismiss);

  useEffect(() => {
    if (open) {
      setFirstName(initial.firstName); setLastName(initial.lastName);
      setPronouns(initial.pronouns); setAvatarUrl(initial.avatarUrl);
      setBase({ firstName: initial.firstName, lastName: initial.lastName, pronouns: initial.pronouns, avatarUrl: initial.avatarUrl });
      setError(null);
    }
  }, [open, initial.firstName, initial.lastName, initial.pronouns, initial.avatarUrl]);

  // per-visit state starts fresh each time the sheet opens
  useEffect(() => {
    sessionRef.current++;
    if (!open) return;
    uploadsRef.current = [];
    setAvatarError(null); setUploading(false); setSaving(false); setSavedFlash(false);
    setConfirmDelete(false); setDeleting(false); setDeleteWord(""); setDeleteError(null);
    setPwOpen(false); setPw(""); setPw2(""); setShowPw(false); setPwTried(false); setPwBusy(false); setPwError(null); setPwDone(null);
    setConfirmSignOut(false); setSigningOut(false); setSignOutError(null); setLeavingHere(false);
  }, [open]);

  // Google-only accounts have no password yet: offer to "set" one instead of "change"
  useEffect(() => {
    if (!open || !supabase) return;
    let on = true;
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      const meta = u?.app_metadata as { provider?: string; providers?: string[] } | undefined;
      const providers = meta?.providers ?? (meta?.provider ? [meta.provider] : []);
      const setHere = u?.user_metadata?.[PASSWORD_SET_FLAG] === true;
      if (on) setHasPassword(providers.length ? providers.includes("email") || setHere : null);
    }).catch(() => { /* keep the default wording */ });
    return () => { on = false; };
  }, [open]);

  // "Profile saved" shows in the footer for a moment, then the footer goes
  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(false), SAVED_MS);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  // each section starts at its top
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
    setScrolled(false);
  }, [active, pushed]);

  // phones: focus follows a push (to Back) and a pop (to the row you came from)
  useEffect(() => {
    const want = navFocus.current;
    if (!want) return;
    navFocus.current = null;
    const el = want === "back" ? backRef.current : tabRefs.current[want];
    el?.focus({ preventScroll: true });
  }, [pushed, phone]);

  if ((!open && !leaving) || typeof document === "undefined") return null;
  const closing = !open;

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const session = sessionRef.current;
    const replacing = avatarUrl;
    setAvatarError(null); setUploading(true);
    try {
      const ready = await prepareAvatarFile(file);
      const url = await onUpload(ready);
      if (session !== sessionRef.current) { void removeAvatarObjects([url], uid); return; } // sheet closed mid-upload
      // a photo uploaded earlier in this session is replaced before it was
      // ever saved: nothing points at it, so tidy it away now. The saved
      // photo is only removed once the profile is saved (Discard keeps it).
      if (replacing && uploadsRef.current.includes(replacing)) {
        uploadsRef.current = uploadsRef.current.filter((u) => u !== replacing);
        void removeAvatarObjects([replacing], uid);
      }
      uploadsRef.current.push(url);
      setAvatarUrl(url);
    } catch (err) {
      if (session === sessionRef.current) setAvatarError(err instanceof Error && err.message ? err.message : "Upload failed. Please try again.");
    } finally {
      if (session === sessionRef.current) setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // The photo the profile points at right now. Profiles aren't live-synced,
  // so another tab or device may have changed it since this sheet opened
  // (and removed the one we were shown). undefined = couldn't tell.
  const storedAvatarUrl = async (): Promise<string | null | undefined> => {
    if (!supabase || !uid) return undefined;
    try {
      const { data, error: err } = await supabase.from("profiles").select("avatar_url").eq("id", uid).maybeSingle();
      if (err || !data) return undefined;
      return (data as { avatar_url: string | null }).avatar_url ?? null;
    } catch { return undefined; }
  };

  const dirty = firstName !== base.firstName || lastName !== base.lastName || pronouns !== base.pronouns || avatarUrl !== base.avatarUrl;

  const save = async () => {
    if (saving) return;
    const session = sessionRef.current;
    setSaving(true); setError(null);
    try {
      const stored = await storedAvatarUrl();
      // photo untouched here: keep whatever is stored now rather than
      // pointing the profile back at a photo another tab replaced
      const nextAvatar = avatarUrl === base.avatarUrl && stored !== undefined ? stored : avatarUrl;
      const draft: ProfileDraft = { firstName: firstName.trim(), lastName: lastName.trim(), pronouns: pronouns.trim(), avatarUrl: nextAvatar };
      await onSave(draft);
      // the profile now points at `nextAvatar`: the photo it replaced and any
      // other uploads from this session are unused
      const unused = [...uploadsRef.current, base.avatarUrl, stored].filter((u) => u && u !== nextAvatar);
      uploadsRef.current = [];
      void removeAvatarObjects(unused, uid);
      if (session !== sessionRef.current) return;
      // the sheet stays open: what was saved is the new baseline
      setBase(draft);
      setFirstName(draft.firstName); setLastName(draft.lastName); setPronouns(draft.pronouns); setAvatarUrl(nextAvatar);
      setSavedFlash(true);
    } catch (err) {
      if (session === sessionRef.current) setError(err instanceof Error ? err.message : "Couldn't save your profile.");
    } finally {
      if (session === sessionRef.current) setSaving(false);
    }
  };

  const discardChanges = () => {
    discardUploads();
    setFirstName(base.firstName); setLastName(base.lastName); setPronouns(base.pronouns); setAvatarUrl(base.avatarUrl);
    setAvatarError(null); setError(null);
  };

  const longEnough = pw.length >= PASSWORD_MIN;
  const mismatch = pw2.length > 0 && pw2 !== pw && (pwTried || pw2.length >= pw.length);
  // submitted with the confirmation left empty
  const confirmMissing = pwTried && longEnough && pw2.length === 0;
  const confirmHint = mismatch ? "The two passwords don't match." : confirmMissing ? "Type your new password again to confirm it." : null;
  // Deferred focus moves: the latest request wins, so a panel's opening focus
  // (30 ms) can't land after — and undo — one asked for since (e.g. "confirm
  // your password" straight after opening the password panel).
  const focusLater = (fn: () => void, ms: number) => { window.clearTimeout(focusTimer.current); focusTimer.current = window.setTimeout(fn, ms); };
  // after a panel swaps back to its trigger button, put focus on that button
  const focusSoon = (el: React.RefObject<HTMLElement>) => focusLater(() => el.current?.focus(), 0);
  // Focus a control inside a Collapse once it has mounted. preventScroll stops
  // the browser scrolling the still-clipped panel (which made its content
  // jump while opening); once it's open, bring the panel into view.
  const focusInPanel = (el: React.RefObject<HTMLElement>, panel: React.RefObject<HTMLElement>) => {
    focusLater(() => el.current?.focus({ preventScroll: true }), 30);
    window.setTimeout(() => panel.current?.scrollIntoView?.({ block: "nearest" }), 330);
  };

  const openPassword = () => {
    setPwDone(null); setPwError(null); setPwTried(false); setPwOpen(true);
    focusInPanel(pwInputRef, pwFormRef);
  };
  const openSignOut = () => {
    setSignOutError(null); setConfirmSignOut(true);
    focusInPanel(signOutCancelRef, signOutPanelRef);
  };
  const closePassword = () => {
    setPwOpen(false); setPw(""); setPw2(""); setShowPw(false); setPwTried(false); setPwError(null);
    focusSoon(pwButtonRef);
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwBusy) return;
    setPwTried(true); setPwError(null);
    const problem = passwordIssue(pw, pw2);
    if (problem) {
      // length and mismatch are already spelled out next to their fields;
      // anything else (too long, only spaces) goes in the error line
      // (focus after the re-render, so the field's hint is read out with it)
      if (!longEnough) focusSoon(pwInputRef);
      else if (pw2 !== pw) focusSoon(pw2InputRef);
      else { setPwError(problem); focusSoon(pwInputRef); }
      return;
    }
    setPwBusy(true);
    let failure: string | undefined;
    try { failure = (await auth.updatePassword(pw)).error; }
    catch (err) { failure = err instanceof Error ? err.message : String(err); }
    setPwBusy(false);
    if (failure != null) { setPwError(friendlyPasswordError(failure)); return; }
    // remember that this Google account now has a password too (best effort)
    if (hasPassword === false && supabase) void supabase.auth.updateUser({ data: { [PASSWORD_SET_FLAG]: true } }).catch(() => { /* wording only */ });
    setPwOpen(false); setPw(""); setPw2(""); setShowPw(false); setPwTried(false); setHasPassword(true);
    setPwDone("Password updated. Use it the next time you sign in.");
    focusSoon(pwButtonRef);
  };

  const signOutEverywhere = async () => {
    if (!supabase || signingOut) return; // the row isn't offered in demo mode
    setSigningOut(true); setSignOutError(null);
    // Photos uploaded in this visit but never saved go first, while this
    // session can still delete them: once signed out, the storage policy
    // refuses and they'd be left in the public bucket.
    const unused = uploadsRef.current;
    uploadsRef.current = [];
    await removeAvatarObjects(unused, uid);
    try {
      // scope "global" revokes every refresh token for this account, so
      // other browsers and phones are signed out when their session next
      // refreshes (within the hour at most)
      const { error: err } = await supabase.auth.signOut({ scope: "global" });
      if (err) throw err;
      await auth.signOut(); // local state; the app returns to the sign-in page
    } catch (err) {
      // still here: the preview can't point at a photo that was just removed
      if (avatarUrl && unused.includes(avatarUrl)) setAvatarUrl(base.avatarUrl);
      setSignOutError(friendlySignOutError(err instanceof Error ? err.message : String(err)));
      setSigningOut(false);
    }
  };

  // this device only; the auth provider asks first if edits haven't synced
  const signOutHere = async () => {
    if (leavingHere) return;
    setLeavingHere(true);
    const unused = uploadsRef.current;   // (see signOutEverywhere)
    uploadsRef.current = [];
    await removeAvatarObjects(unused, uid);
    try {
      if (onSignOut) onSignOut(); else await auth.signOut();
    } finally {
      // chose to stay (unsynced edits): don't show a photo that was just removed
      if (avatarUrl && unused.includes(avatarUrl)) setAvatarUrl(base.avatarUrl);
      setLeavingHere(false);
    }
  };

  const deleteConfirmed = deleteWord.trim().toUpperCase() === DELETE_WORD;
  const deleteAccount = async () => {
    if (!deleteConfirmed || deleting) return;
    setDeleting(true); setDeleteError(null);
    // The face photo lives in a public bucket and doesn't go with the account,
    // so remove it (and anything uploaded in this visit) while this session
    // can. Only this person's own "<uid>/avatar-*" files are touched.
    const photos = [...uploadsRef.current, base.avatarUrl, avatarUrl];
    uploadsRef.current = [];
    await removeAvatarObjects(photos, uid);
    try { await onDeleteAccount(); }
    catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Couldn't delete your account.";
      setDeleting(false);
      if (avatarObjectPath(avatarUrl, uid)) setAvatarUrl(null);
      if (!avatarObjectPath(base.avatarUrl, uid)) { setDeleteError(message); return; }
      // the account is still here but its saved photo is gone: stop the
      // profile pointing at it so nobody sees a broken image
      const cleared = { firstName: base.firstName, lastName: base.lastName, pronouns: base.pronouns, avatarUrl: null };
      try { await onSave(cleared); setBase(cleared); } catch { /* shown below either way */ }
      setDeleteError(`${message} Your profile photo was already removed; you can add it again.`);
    }
  };

  const previewName = [firstName, lastName].filter(Boolean).join(" ") || email;
  const savedName = [base.firstName, base.lastName].filter(Boolean).join(" ") || email;
  const pwLabel = hasPassword === false ? "Set a password" : "Change password";
  const setLook = (patch: Partial<Appearance>) => { if (appearance) onChangeAppearance?.({ ...appearance, ...patch }); };
  const leaveThen = (fn?: () => void) => () => { dismiss(); fn?.(); };

  /* ---------- section bodies ---------- */

  const avatar = (size: number, url: string | null, name: string) => url
    ? <img src={url} alt="" className="kset-avatar" style={{ width: size, height: size }} />
    : (
      <span aria-hidden="true" className="kset-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: avatarPaint(color).fill, color: avatarPaint(color).ink }}>
        {memberInitials(name)}
      </span>
    );

  const profileSection = () => (
    <>
      <div className="kset-photo">
        {avatar(64, avatarUrl, previewName)}
        <div className="kset-photo-text">
          <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} onChange={pickFile} style={{ display: "none" }} aria-label="Upload profile photo" />
          <div className="kset-photo-acts">
            <Button size="sm" icon="user" onClick={() => fileRef.current?.click()} disabled={uploading} loading={uploading}>
              {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Upload photo"}
            </Button>
            {avatarUrl && !uploading && (
              <Button size="sm" variant="ghost" onClick={() => { setAvatarError(null); setAvatarUrl(null); }} aria-label="Remove profile photo">Remove</Button>
            )}
          </div>
          {avatarError
            ? <p role="alert" className="kset-hint" data-tone="signal">{avatarError}</p>
            : <p className="kset-hint">PNG, JPG, GIF or WebP, up to 5 MB.</p>}
        </div>
      </div>

      <div className="kset-fields">
        <div className="kset-field">
          <label htmlFor={`${ids}-first`}>First name</label>
          <input id={`${ids}-first`} className="kset-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" autoComplete="given-name" />
        </div>
        <div className="kset-field">
          <label htmlFor={`${ids}-last`}>Last name</label>
          <input id={`${ids}-last`} className="kset-input" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" autoComplete="family-name" />
        </div>
        <div className="kset-field">
          <label htmlFor={`${ids}-pronouns`}>Pronouns</label>
          <input id={`${ids}-pronouns`} className="kset-input" list={`${ids}-pronoun-options`} value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="they/them" />
          <datalist id={`${ids}-pronoun-options`}>
            {PRONOUN_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
          </datalist>
          <p className="kset-hint">Optional. Shown next to your name.</p>
        </div>
        <div className="kset-field" data-span="2">
          <label htmlFor={`${ids}-email`}>Email</label>
          <div className="kset-input-wrap">
            <input id={`${ids}-email`} className="kset-input" value={email} readOnly disabled />
            <Icon name="lock" size={16} className="kset-input-icon" />
          </div>
          <p className="kset-hint">Your sign-in email can't be changed here.</p>
        </div>
      </div>
      {error && <p role="alert" className="kset-err">{error}</p>}
    </>
  );

  const segmented = <T extends string>(opts: { id: T; label: string; icon?: IconName }[], value: T, onPick: (v: T) => void) => (
    <div className="kseg kset-seg">
      {opts.map((o) => (
        <button key={o.id} type="button" className="kseg-btn" data-active={o.id === value} aria-pressed={o.id === value} onClick={() => onPick(o.id)}>
          {o.icon && <Icon name={o.icon} size={16} sw={1.75} />}{o.label}
        </button>
      ))}
    </div>
  );

  const onSwatchKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!appearance) return;
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? ACCENTS.length - 1 : null;
    if (!dir && to === null) return;
    e.preventDefault();
    const i = ACCENTS.findIndex((a) => a.id === appearance.accent);
    const n = to ?? (i + dir + ACCENTS.length) % ACCENTS.length;
    setLook({ accent: ACCENTS[n].id });
    (e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[n])?.focus();
  };

  const appearanceSection = () => (
    <>
      {((theme && onChangeTheme) || appearance) && (
        <Group title="Theme and colour">
          {theme && onChangeTheme && (
            <Row group label="Theme" desc="System follows your device's light or dark setting.">
              {segmented(THEMES, theme, onChangeTheme)}
            </Row>
          )}
          {appearance && (
            <Row group label="Accent colour" desc="Buttons, selection and focus rings.">
              <div role="radiogroup" aria-label="Accent colour" className="kset-swatches" onKeyDown={onSwatchKey}>
                {ACCENTS.map((a) => {
                  const on = appearance.accent === a.id;
                  return (
                    <button key={a.id} type="button" role="radio" aria-checked={on} aria-label={a.label} title={a.label} tabIndex={on ? 0 : -1}
                      className="kset-swatch" style={{ "--sw": accentSwatch(a.id) } as CSSProperties}
                      onClick={() => { if (!on) setLook({ accent: a.id }); }}>
                      {on && <Icon name="check" size={14} sw={2.5} />}
                    </button>
                  );
                })}
              </div>
            </Row>
          )}
        </Group>
      )}
      {appearance && (
        <>
          <Group title="Layout">
            <Row group label="Text size" desc="Scales all of Kanbo, dialogs included.">
              {segmented(TEXT_SIZES, appearance.textSize, (v) => setLook({ textSize: v }))}
            </Row>
            <Row group label="Density" desc="Compact fits more rows on screen.">
              {segmented(DENSITIES, appearance.density ?? "comfortable", (v) => setLook({ density: v }))}
            </Row>
          </Group>
          <Group title="Suggestions and AI">
            <div className="kset-row">
              <Toggle checked={appearance.suggestions !== false} onChange={(v) => setLook({ suggestions: v })}
                label="Show Kanbo suggestions on Today" description="A suggested plan, drawn as dashed blocks. Nothing moves until you accept it." />
            </div>
            <div className="kset-row">
              <Toggle checked={appearance.ai !== false} onChange={(v) => setLook({ ai: v })}
                label="Use Kanbo AI" description="When off, Kanbo uses on-device rules only and sends nothing to the AI service." />
            </div>
          </Group>
          <p className="kset-note">Changes apply straight away and are remembered on this device.</p>
        </>
      )}
      {!appearance && !(theme && onChangeTheme) && <EmptyState size="sm" title="Nothing to change here yet" body="Appearance settings aren't available in this view." />}
    </>
  );

  const notificationsSection = () => (
    <>
      <p className="kset-intro">Choose how Kanbo lets you know when something needs you.</p>
      <div className="kset-card">
        <table className="kset-matrix">
          <caption className="sr-only">Notifications</caption>
          <thead>
            <tr><th scope="col"><span className="sr-only">Notification</span></th><th scope="col">In-app</th><th scope="col">Email</th></tr>
          </thead>
          <tbody>
            {NOTIF_ROWS.map((r) => (
              <tr key={r.key}>
                <th scope="row">
                  <span className="kset-row-label">{r.label}</span>
                  <span className="kset-row-desc">{r.hint}</span>
                </th>
                {/* due reminders are email-only (sent by the daily job) */}
                <td>{r.key === "due"
                  ? <span className="kset-na"><span aria-hidden="true">–</span><span className="sr-only">Not available in the app</span></span>
                  : <PrefCheck checked={prefOn(r.key)} onChange={() => togglePref(r.key)} label={`${r.label} in-app`} disabled={!onSaveNotifyPrefs} />}</td>
                <td><PrefCheck checked={prefOn(`${r.key}_email`)} onChange={() => togglePref(`${r.key}_email`)} label={`${r.label} email`} disabled={!onSaveNotifyPrefs} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  const calendarSection = () => calendar ? (
    <>
      <Group title="Calendars" action={calendar.syncing ? <span className="kset-sync" role="status"><span className="kspin" aria-hidden="true" />Syncing…</span> : undefined}>
        {CAL_PROVIDERS.map((p, i) => {
          const conn = calendar.connections.find((c) => c.provider === p.id);
          return (
            <Row key={p.id} icon={<Icon name="calendar" size={16} sw={1.75} />} label={p.label}
              desc={conn ? <><span className="kset-ok">Connected</span>{conn.accountEmail ? ` · ${conn.accountEmail}` : ""}</> : `Connect ${p.short} to see meetings on Today.`}>
              {conn
                ? <Button size="sm" onClick={() => calendar.onDisconnect(p.id)} aria-label={`Disconnect ${p.label}`}>Disconnect</Button>
                : <Button size="sm" variant={i === 0 ? "primary" : "secondary"} onClick={() => calendar.onConnect(p.id)} aria-label={`Connect ${p.label}`}>Connect</Button>}
            </Row>
          );
        })}
      </Group>
      <p className="kset-note">Kanbo only reads your events, to show your meetings on Today and Month. Nothing is written back to your calendar.</p>
    </>
  ) : (
    <EmptyState size="sm" art="calendar" title="Connect a calendar from Month" body="Open Today › Month and choose Connect calendar to see your meetings alongside your tasks." />
  );

  const workspaceSection = () => (
    <>
      {onGoPeople && (
        <Group title="People">
          <Row label="Members & roles" desc="Invite people, change roles and remove members.">
            <Button size="sm" iconRight="arrowRight" onClick={leaveThen(onGoPeople)}>Members & roles</Button>
          </Row>
        </Group>
      )}
      <div className="kset-embed">{renderWorkspace?.()}</div>
    </>
  );

  const billingSection = () => (
    <BillingPanel enabled={!!billing?.enabled} subscription={billing?.subscription ?? null} guest={!!isGuest}
      onUpgrade={billing?.onUpgrade} onManageBilling={billing?.onManageBilling} />
  );

  const tagsSection = () => tagsPanel ? (
    <>
      <p className="kset-intro">Tags cut across projects. Rename, recolour, merge or delete them here, and every task follows.</p>
      <TagManagerPanel {...tagsPanel} />
    </>
  ) : (
    <EmptyState size="sm" art="layers" title="Tags live on your tasks" body="Add a tag from any task. You can manage every tag from here once there are some." />
  );

  const shortcutsSection = () => (
    <>
      <p className="kset-intro">Single-key shortcuts pause while you're typing or while a dialog is open. Every one has a mouse or touch equivalent.</p>
      <div className="kset-keys">
        {SHORTCUT_GROUPS.map((g) => {
          const rows = mergeShortcuts(SHORTCUTS.filter((s) => s.group === g));
          if (!rows.length) return null;
          return (
            <section key={g} className="kset-keygroup" aria-labelledby={`${ids}-kg-${g}`}>
              <h4 id={`${ids}-kg-${g}`} className="kset-group-title">{g === "Navigate" ? "Go to" : g}</h4>
              <ul className="kset-card kset-keylist">
                {rows.map((r) => (
                  <li key={r.label + r.keys.join()} className="kset-keyrow">
                    <span className="kset-keylabel">{r.label}</span>
                    <KeyCombo alts={r.keys} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );

  const dataSection = () => (
    <Group title="Your data">
      <Row label="Export my data" desc="Download all your tasks and projects as a JSON file.">
        <Button size="sm" icon="archive" onClick={onExport}>Export</Button>
      </Row>
      {onImport && (
        <Row label="Import tasks" desc="Paste a list, or bring in a CSV from Asana, Trello, Jira or Planner.">
          <Button size="sm" icon="arrowUpRight" onClick={leaveThen(onImport)}>Import tasks…</Button>
        </Row>
      )}
    </Group>
  );

  const accountSection = () => (
    <>
      <Group title="Password & sign-in">
        <div>
          <Row label="Password" desc={hasPassword === false ? "You sign in with Google. Add a password to sign in with your email too." : "Change the password you use to sign in."}>
            {!pwOpen && <Button ref={pwButtonRef} size="sm" icon="lock" onClick={openPassword}>{pwLabel}</Button>}
          </Row>
          <div role="status">
            {pwDone && !pwOpen && (
              <p className="kset-done"><Icon name="check" size={16} sw={2} /> {pwDone}</p>
            )}
          </div>
          <Collapse open={pwOpen}>
            <form ref={pwFormRef} onSubmit={changePassword} noValidate aria-label={pwLabel} className="kset-panel">
              {/* lets password managers file the new password under the right account */}
              <input type="email" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" style={{ display: "none" }} />
              <div className="kset-field">
                <label htmlFor="kanbo-new-password">New password</label>
                <div className="kset-input-wrap">
                  <input ref={pwInputRef} id="kanbo-new-password" name="new-password" type={showPw ? "text" : "password"} autoComplete="new-password" className="kset-input"
                    value={pw} onChange={(e) => { setPw(e.target.value); setPwError(null); }} style={{ paddingRight: 72 }}
                    aria-invalid={pwTried && !longEnough ? true : undefined} aria-describedby="kanbo-new-password-hint" />
                  <button type="button" className="kset-reveal" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw} aria-label={showPw ? "Hide passwords" : "Show passwords"}>
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
                <p id="kanbo-new-password-hint" className="kset-hint kset-hint-icon" data-tone={longEnough ? "ok" : pwTried ? "signal" : undefined}>
                  <Icon name={longEnough ? "check" : "dot"} size={14} sw={2} />
                  <span>At least {PASSWORD_MIN} characters. A short phrase is easy to remember and hard to guess.</span>
                </p>
              </div>
              <div className="kset-field">
                <label htmlFor="kanbo-confirm-password">Confirm new password</label>
                <input ref={pw2InputRef} id="kanbo-confirm-password" name="confirm-password" type={showPw ? "text" : "password"} autoComplete="new-password" className="kset-input"
                  value={pw2} onChange={(e) => { setPw2(e.target.value); setPwError(null); }}
                  aria-invalid={confirmHint ? true : undefined} aria-describedby={confirmHint ? "kanbo-confirm-password-hint" : undefined} />
                {confirmHint && <p id="kanbo-confirm-password-hint" className="kset-hint" data-tone="signal">{confirmHint}</p>}
              </div>
              {pwError && <p role="alert" className="kset-err">{pwError}</p>}
              <div className="kset-panel-acts">
                <Button variant="ghost" onClick={closePassword} disabled={pwBusy}>Cancel</Button>
                <Button type="submit" variant="primary" icon="check" disabled={pwBusy} aria-busy={pwBusy || undefined}>
                  {pwBusy ? "Updating…" : hasPassword === false ? "Set password" : "Update password"}
                </Button>
              </div>
            </form>
          </Collapse>
        </div>

        {/* demo mode has no sessions to end (App hides Sign out there too) */}
        {auth.configured && (
          <Row label="Sign out" desc="Sign out of Kanbo on this device.">
            <Button size="sm" icon="logout" onClick={() => { void signOutHere(); }} loading={leavingHere}>Sign out</Button>
          </Row>
        )}
        {auth.configured && (
          <div>
            <Row label="Sign out of all devices" desc="Lost a laptop or phone, or used a shared computer? End every session, including this one.">
              {!confirmSignOut && <Button ref={signOutButtonRef} size="sm" icon="logout" onClick={openSignOut}>Sign out everywhere</Button>}
            </Row>
            <Collapse open={confirmSignOut}>
              <div ref={signOutPanelRef} role="group" aria-label="Confirm signing out of all devices" className="kset-panel">
                <p className="kset-panel-text">
                  You'll be signed out on every browser and device, including this one. Other devices lose access within the hour at the latest. Your work isn't affected.
                </p>
                {signOutError && <p role="alert" className="kset-err">{signOutError}</p>}
                <div className="kset-panel-acts">
                  <Button ref={signOutCancelRef} variant="ghost" onClick={() => { setConfirmSignOut(false); focusSoon(signOutButtonRef); }} disabled={signingOut}>Cancel</Button>
                  <Button variant="primary" icon="logout" onClick={signOutEverywhere} disabled={signingOut} aria-busy={signingOut || undefined}>
                    {signingOut ? "Signing out…" : "Sign out everywhere"}
                  </Button>
                </div>
              </div>
            </Collapse>
          </div>
        )}
      </Group>

      {/* the danger zone is always last */}
      <Group title="Danger zone" danger>
        <div>
          <Row label="Delete account" desc="Deletes your account and personal work. Team work stays with your team.">
            {!confirmDelete && (
              <Button ref={deleteButtonRef} size="sm" icon="trash" className="kset-btn-signal" onClick={() => { setDeleteError(null); setDeleteWord(""); setConfirmDelete(true); }}>
                Delete account
              </Button>
            )}
          </Row>
          {confirmDelete && (
            <div role="group" aria-labelledby="kanbo-delete-title" className="kset-panel" data-tone="signal">
              <p id="kanbo-delete-title" className="kset-panel-title">Delete your account? This can't be undone.</p>
              <ul className="kset-bullets">
                <li><strong>Deleted for good:</strong> your profile, your profile photo, and your personal tasks and projects.</li>
                <li><strong>Kept for your team:</strong> tasks and projects you created in team workspaces stay where they are. Your comments stay too, still showing your name.</li>
                <li><strong>Workspaces you own</strong> pass to their next admin or, if there isn't one, to the longest-standing person left in the workspace. A workspace with nobody else in it is deleted.</li>
              </ul>
              <p className="kset-panel-text">
                Want a copy first?{" "}
                <button type="button" className="kset-link" onClick={onExport}>Export my data</button>
              </p>
              <div className="kset-field">
                <label htmlFor="kanbo-delete-confirm">Type {DELETE_WORD} to confirm</label>
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input id="kanbo-delete-confirm" autoFocus className="kset-input kset-input-mono" value={deleteWord} onChange={(e) => setDeleteWord(e.target.value)}
                  autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={deleting}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void deleteAccount(); } }} />
              </div>
              {deleteError && <p role="alert" className="kset-err">{deleteError}</p>}
              <div className="kset-panel-acts">
                <Button variant="ghost" onClick={() => { setConfirmDelete(false); setDeleteWord(""); setDeleteError(null); focusSoon(deleteButtonRef); }} disabled={deleting}>Cancel</Button>
                <Button variant="danger" icon="trash" onClick={deleteAccount} disabled={!deleteConfirmed || deleting} aria-busy={deleting || undefined}>
                  {deleting ? "Deleting…" : "Delete forever"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Group>
    </>
  );

  const bodyOf = (s: SettingsSection): ReactNode => {
    switch (s) {
      case "profile": return profileSection();
      case "appearance": return appearanceSection();
      case "notifications": return notificationsSection();
      case "calendar": return calendarSection();
      case "workspace": return workspaceSection();
      case "billing": return billingSection();
      case "tags": return tagsSection();
      case "shortcuts": return shortcutsSection();
      case "data": return dataSection();
      case "account": return accountSection();
    }
  };

  /* ---------- chrome ---------- */

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const s = e.currentTarget.scrollTop > 0;
    if (s !== scrolled) setScrolled(s);
  };

  // vertical tablist: ↑/↓ move and select, Home/End jump
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = available.findIndex((s) => s.id === active);
    let n: number;
    if (e.key === "ArrowDown") n = (i + 1) % available.length;
    else if (e.key === "ArrowUp") n = (i - 1 + available.length) % available.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = available.length - 1;
    else return;
    e.preventDefault();
    const next = available[n].id;
    pick(next);
    tabRefs.current[next]?.focus();
  };

  const footer = active === "profile" && (dirty || savedFlash) ? (
    <div className="kset-foot" data-state={dirty ? "dirty" : "saved"}>
      {dirty ? (
        <>
          <span className="kset-foot-note">Unsaved changes</span>
          <Button variant="ghost" onClick={discardChanges} disabled={saving}>Discard</Button>
          <Button variant="primary" icon="check" onClick={() => { void save(); }} disabled={saving || uploading} aria-busy={saving || undefined}>
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </>
      ) : (
        <span className="kset-foot-note" data-tone="ok"><Icon name="check" size={16} sw={2} /> Profile saved</span>
      )}
    </div>
  ) : null;

  const profileDot = dirty ? <><span className="kset-tab-dot" aria-hidden="true" /><span className="sr-only">, unsaved changes</span></> : null;

  const desktop = (
    <>
      <div className="kset-nav">
        <p className="kset-nav-title" aria-hidden="true">Settings</p>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" className="kset-tabs" onKeyDown={onTabKey}>
          {available.map((s, i) => {
            const on = s.id === active;
            return (
              <button key={s.id} ref={(el) => { tabRefs.current[s.id] = el; }} type="button" role="tab" id={`${ids}-tab-${s.id}`}
                aria-selected={on} aria-controls={`${ids}-panel`} tabIndex={on ? 0 : -1} data-autofocus={on ? "" : undefined}
                data-sep={s.sep && i > 0 ? "" : undefined} className="kset-tab" onClick={() => pick(s.id)}>
                <Icon name={s.icon} size={16} sw={1.75} />
                <span className="kset-tab-label">{s.label}</span>
                {s.id === "profile" && profileDot}
              </button>
            );
          })}
        </div>
      </div>
      <div className="kset-pane">
        <div className="kset-head" data-scrolled={scrolled || undefined}>
          <h2 id={`${ids}-title`} className="kset-title">{meta.label}</h2>
          <IconButton icon="x" label="Close settings" onClick={dismiss} />
        </div>
        <div ref={scrollRef} className="kset-scroll" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${active}`} tabIndex={0} onScroll={onScroll}>
          <div key={active} className="kset-sec" data-section={active}>{bodyOf(active)}</div>
        </div>
        {footer}
      </div>
    </>
  );

  const openSection = (s: SettingsSection) => { pick(s); navFocus.current = "back"; setPushed(true); };
  const backToList = () => { navFocus.current = active; setPushed(false); };
  const hintOf = (s: SettingsSection): string | null => {
    if (s === "appearance" && theme) return THEMES.find((t) => t.id === theme)?.label ?? null;
    if (s === "calendar" && calendar) return calendar.connections.length ? "Connected" : null;
    if (s === "tags" && tagsPanel) { const n = Object.keys(tagsPanel.tags).length; return n ? String(n) : null; }
    return null;
  };

  const mobile = pushed ? (
    <>
      <div className="kset-head" data-scrolled={scrolled || undefined} data-phone="">
        <IconButton ref={backRef} icon="arrowLeft" label="All settings" onClick={backToList} />
        <h2 id={`${ids}-title`} className="kset-title">{meta.label}</h2>
        <IconButton icon="x" label="Close settings" onClick={dismiss} />
      </div>
      <div ref={scrollRef} className="kset-scroll" role="region" aria-labelledby={`${ids}-title`} onScroll={onScroll}>
        <div key={active} className="kset-sec kset-push" data-section={active}>{bodyOf(active)}</div>
      </div>
      {footer}
    </>
  ) : (
    <>
      <div className="kset-head" data-scrolled={scrolled || undefined} data-phone="">
        <h2 id={`${ids}-title`} className="kset-title">Settings</h2>
        <IconButton icon="x" label="Close settings" onClick={dismiss} />
      </div>
      <div ref={scrollRef} className="kset-scroll" onScroll={onScroll}>
        <nav className="kset-sec kset-pop kset-mlist" aria-label="Settings sections">
          <button ref={(el) => { tabRefs.current.profile = el; }} type="button" className="kset-me" data-autofocus="" onClick={() => openSection("profile")}>
            {avatar(40, base.avatarUrl, savedName)}
            <span className="kset-me-text">
              <span className="kset-me-name">{savedName}{profileDot}</span>
              <span className="kset-me-sub">{email && savedName !== email ? email : "Photo, name and pronouns"}</span>
            </span>
            <Icon name="chevronRight" size={16} sw={1.75} className="kset-chev" />
          </button>
          {[available.filter((s) => s.id !== "profile" && !s.sep && SECTIONS.indexOf(s) < 4),
            available.filter((s) => SECTIONS.indexOf(s) >= 4 && SECTIONS.indexOf(s) < 7),
            available.filter((s) => SECTIONS.indexOf(s) >= 7)].map((grp, gi) => grp.length ? (
            <div key={gi} className="kset-mgroup">
              {grp.map((s) => {
                const hint = hintOf(s.id);
                return (
                  <button key={s.id} ref={(el) => { tabRefs.current[s.id] = el; }} type="button" className="kset-mrow" onClick={() => openSection(s.id)}>
                    <Icon name={s.icon} size={16} sw={1.75} />
                    <span className="kset-mrow-label">{s.label}</span>
                    {hint && <span className="kset-mrow-hint">{hint}</span>}
                    <Icon name="chevronRight" size={16} sw={1.75} className="kset-chev" />
                  </button>
                );
              })}
            </div>
          ) : null)}
        </nav>
      </div>
    </>
  );

  return createPortal(
    <div className="kbackdrop ksheet-layer kset-layer" data-state={closing ? "closing" : "open"} aria-hidden={closing || undefined}
      // a press that starts inside (selecting text) and ends on the scrim must not close it
      onMouseDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation(); // a portal still bubbles to its React parent
        if (!closing && downOnScrim.current && e.target === e.currentTarget) dismiss();
        downOnScrim.current = false;
      }}>
      <style>{SETTINGS_CSS}</style>
      <div ref={trapRef} className="ksheet kset" role={closing ? undefined : "dialog"} aria-modal={closing ? undefined : true} aria-label="Settings"
        data-phone={phone || undefined}>
        {phone ? mobile : desktop}
        <div role="status" className="sr-only">{savedFlash ? "Profile saved" : ""}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- small building blocks ---------- */

function Group({ title, children, danger, action }: { title: string; children: ReactNode; danger?: boolean; action?: ReactNode }) {
  const id = "kset-g" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <section className="kset-group" data-tone={danger ? "signal" : undefined} aria-labelledby={id}>
      <div className="kset-group-head">
        <h3 id={id} className="kset-group-title">{title}</h3>
        {action}
      </div>
      <div className="kset-card">{children}</div>
    </section>
  );
}

/** label (and a line of help) on the left, the control on the right. `group`
 *  makes the row a labelled group — for segmented controls and swatches. */
function Row({ label, desc, icon, group, children }: { label: ReactNode; desc?: ReactNode; icon?: ReactNode; group?: boolean; children?: ReactNode }) {
  const id = "kset-r" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <div className="kset-row" role={group ? "group" : undefined} aria-labelledby={group ? `${id}-l` : undefined} aria-describedby={group && desc ? `${id}-d` : undefined}>
      {icon && <span className="kset-row-icon">{icon}</span>}
      <div className="kset-row-text">
        <span id={`${id}-l`} className="kset-row-label">{label}</span>
        {desc && <span id={`${id}-d`} className="kset-row-desc">{desc}</span>}
      </div>
      {children != null && children !== false && <div className="kset-row-ctl">{children}</div>}
    </div>
  );
}

/** a square checkbox that reads like the kit's Check (without the completion pop) */
function PrefCheck({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <label className="kset-check" data-disabled={disabled || undefined}>
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} disabled={disabled} />
      <span className="kset-check-box" aria-hidden="true"><Icon name="check" size={12} sw={2.5} /></span>
    </label>
  );
}

/** Rows that share a label ("⌘K" and "/" both search) become one row with alternatives. */
function mergeShortcuts(list: Shortcut[]): { label: string; keys: string[] }[] {
  const out: { label: string; keys: string[] }[] = [];
  for (const s of list) {
    const same = out.find((r) => r.label === s.label);
    if (same) same.keys.push(s.keys); else out.push({ label: s.label, keys: [s.keys] });
  }
  return out;
}

const SPOKEN: Record<string, string> = { "⌘": IS_MAC ? "Command" : "Control", "⇧": "Shift", "⏎": "Enter", "/": "slash", "?": "question mark", ",": "comma" };
const spokenKey = (k: string) => (k === "Esc" ? "Escape" : Array.from(k).map((c) => SPOKEN[c] ?? c).join(" "));
const visualKey = (k: string) => (IS_MAC ? k : k.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+"));

/** "G D" → G then D · "J / K" → J / K · alternatives → "or". Read out in words. */
function KeyCombo({ alts }: { alts: string[] }) {
  const spoken = alts.map((a) => a.split(" / ").map((p) => p.split(" ").map(spokenKey).join(" then ")).join(", ")).join(" or ");
  return (
    <span className="kset-combo">
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true" className="kset-combo-keys">
        {alts.map((a, ai) => (
          <span key={ai} className="kset-combo-alt">
            {ai > 0 && <span className="kset-then">or</span>}
            {a.split(" / ").map((pair, pi) => (
              <span key={pi} className="kset-combo-alt">
                {pi > 0 && <span className="kset-then">/</span>}
                {pair.split(" ").map((k, ki) => (
                  <span key={ki} className="kset-combo-alt">
                    {ki > 0 && <span className="kset-then">then</span>}
                    <kbd className="kkbd">{visualKey(k)}</kbd>
                  </span>
                ))}
              </span>
            ))}
          </span>
        ))}
      </span>
    </span>
  );
}

/* Scoped styles. Every token that's new in Paper & Navy is read with a
   fallback to today's, so this looks right before and after P01's pass. */
const SETTINGS_CSS = `
.ksheet-layer.kset-layer { align-items: center; padding: 24px; }
.ksheet.kset { flex-direction: row; width: min(880px, 100%); height: min(760px, 100%); overflow: hidden; }

/* ---- section list ---- */
.kset-nav {
  display: flex; flex-direction: column; flex-shrink: 0; width: 200px; min-height: 0; overflow-y: auto;
  padding: 0 6px 16px; background: var(--bg-deep, var(--bg-sunken));
  box-shadow: inset -1px 0 0 var(--hairline);
}
/* 56px, so it lines up with the pane's title */
.kset-nav-title { margin: 0; padding: 0 10px; height: 56px; flex-shrink: 0; display: flex; align-items: center; font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kset-tabs { display: flex; flex-direction: column; gap: 2px; }
.kset-tab {
  position: relative; display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px 0 10px;
  border: 0; border-radius: var(--r-sm, 6px); background: transparent; cursor: pointer; text-align: left;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2);
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.kset-tab > svg { color: var(--icon-quiet, var(--ink-4)); transition: color var(--d-1, 90ms) var(--ease); }
.kset-tab:hover { background: var(--fill-1); color: var(--ink); }
.kset-tab[aria-selected="true"] { background: var(--bg-selected, var(--accent-dim)); color: var(--ink); font-weight: 600; }
.kset-tab[aria-selected="true"] > svg { color: var(--accent-text, var(--accent)); }
.kset-tab[data-sep] { margin-top: 17px; }
.kset-tab[data-sep]::before { content: ""; position: absolute; left: 10px; right: 10px; top: -9px; height: 1px; background: var(--hairline); pointer-events: none; }
.kset-tab-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: -0.005em; }
.kset-tab-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--accent-text, var(--accent)); }

/* ---- pane ---- */
.kset-pane { position: relative; display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.kset-head {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0; height: 56px; padding: 0 12px 0 32px;
  box-shadow: 0 1px 0 transparent; transition: box-shadow var(--d-2, 160ms) var(--ease); position: relative; z-index: 1;
}
.kset-head[data-scrolled] { box-shadow: 0 1px 0 var(--hairline); }
.kset-title {
  flex: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 600 20px/28px var(--font-head, var(--font-display)); letter-spacing: -0.012em; color: var(--ink);
}
.kset-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 32px 32px; }
.kset-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.kset-sec { animation: ksetIn var(--d-2, 160ms) var(--ease); }
@keyframes ksetIn { from { opacity: 0.35; translate: 0 4px; } }
.kset-intro { margin: 0 0 20px; max-width: 540px; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kset-note { margin: 12px 2px 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }

/* ---- groups, cards, rows ---- */
.kset-group + .kset-group, .kset-group + .kset-embed, .kset-embed + .kset-group { margin-top: 28px; }
.kset-group-head { display: flex; align-items: center; gap: 8px; min-height: 20px; margin: 0 2px 8px; }
.kset-group-title { flex: 1; margin: 0; font: 600 12px/16px var(--font-ui, var(--font-display)); letter-spacing: 0; color: var(--ink-3); }
.kset-group[data-tone="signal"] .kset-group-title { color: var(--signal, var(--prio-urgent)); }
.kset-card { margin: 0; padding: 0; list-style: none; border-radius: var(--r-lg, 12px); background: var(--surface-raised); box-shadow: 0 0 0 1px var(--hairline-strong); }
.kset-group[data-tone="signal"] .kset-card { box-shadow: 0 0 0 1px color-mix(in oklch, var(--signal, var(--prio-urgent)) 38%, transparent); }
.kset-card > * + * { box-shadow: inset 0 1px 0 var(--hairline); }
.kset-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; min-height: 60px; padding: 12px 16px; }
.kset-row > .ktoggle { flex: 1; min-width: 0; }
.kset-row-icon { display: grid; place-items: center; width: 16px; flex-shrink: 0; align-self: flex-start; margin-top: 2px; color: var(--ink-3); }
.kset-row-text { display: grid; gap: 2px; flex: 1 1 240px; min-width: 0; }
.kset-row-label { font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kset-row-desc { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kset-row-ctl { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
.kset-ok { color: var(--ok, var(--st-done)); font-weight: 600; }
.kset-sync { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kset-embed:empty { display: none; }

/* segmented (P01 restyles .kseg; this only sizes it for a row) */
.kset-seg { flex-shrink: 0; }
.kset-seg .kseg-btn { white-space: nowrap; }

/* accent swatches */
.kset-swatches { display: flex; flex-wrap: wrap; gap: 10px; padding: 4px; }
.kset-swatch {
  position: relative; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
  cursor: pointer; background: var(--sw); color: oklch(1 0 0);
  box-shadow: 0 0 0 1px oklch(0 0 0 / 0.08) inset;
  transition: box-shadow var(--d-1, 90ms) var(--ease), transform var(--d-1, 90ms) var(--ease);
}
.kset-swatch svg { filter: drop-shadow(0 1px 1px oklch(0 0 0 / 0.35)); }
.kset-swatch:hover:not([aria-checked="true"]) { box-shadow: 0 0 0 2px var(--surface-raised), 0 0 0 4px color-mix(in oklch, var(--sw) 45%, transparent); }
.kset-swatch[aria-checked="true"] { box-shadow: 0 0 0 2px var(--surface-raised), 0 0 0 4px var(--sw); }
.kset-swatch:focus-visible { outline-offset: 5px; }

/* notification matrix */
.kset-matrix { width: 100%; border-collapse: collapse; }
.kset-matrix th, .kset-matrix td { padding: 12px 16px; text-align: left; vertical-align: middle; }
.kset-matrix thead th { padding-top: 10px; padding-bottom: 6px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kset-matrix thead th + th, .kset-matrix td { width: 72px; text-align: center; padding-left: 4px; padding-right: 4px; }
.kset-matrix td:last-child, .kset-matrix thead th:last-child { padding-right: 12px; }
.kset-matrix tbody tr { box-shadow: inset 0 1px 0 var(--hairline); }
.kset-matrix tbody th { display: grid; gap: 2px; font-weight: inherit; }
.kset-na { color: var(--ink-4); font: 500 13px/20px var(--font-ui, var(--font-display)); }
.kset-check { position: relative; display: inline-grid; place-items: center; width: 32px; height: 32px; vertical-align: middle; cursor: pointer; }
.kset-check input { position: absolute; top: 8px; left: 8px; width: 16px; height: 16px; margin: 0; opacity: 0; cursor: pointer; }
.kset-check-box {
  display: grid; place-items: center; width: 16px; height: 16px; border-radius: var(--r-xs, 4px);
  border: 1.5px solid var(--control-border, var(--hairline-strong)); color: transparent; pointer-events: none;
  transition: background var(--d-2, 160ms) var(--ease), border-color var(--d-2, 160ms) var(--ease), color var(--d-2, 160ms) var(--ease);
}
.kset-check:hover .kset-check-box { border-color: var(--ink-3); }
/* the real checkbox is invisible, so its ring goes on the box you see */
.kset-check input:focus-visible { outline: none !important; }
.kset-check input:focus-visible + .kset-check-box { outline: 2px solid var(--accent); outline-offset: 2px; }
.kset-check input:checked + .kset-check-box { background: var(--accent-fill, var(--accent)); border-color: transparent; color: var(--on-accent); }
.kset-check[data-disabled] { opacity: 0.45; cursor: not-allowed; }

/* shortcuts */
.kset-keys { columns: 2 260px; column-gap: 16px; }
.kset-keygroup { break-inside: avoid; margin-bottom: 24px; }
.kset-keygroup .kset-group-title { margin: 0 2px 8px; }
.kset-keyrow { display: flex; align-items: center; gap: 12px; min-height: 36px; padding: 6px 12px 6px 14px; }
.kset-keylabel { flex: 1; min-width: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kset-combo-keys, .kset-combo-alt { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
.kset-then { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-4); padding: 0 1px; }

/* profile */
.kset-photo { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.kset-avatar { display: grid; place-items: center; flex-shrink: 0; border-radius: 50%; object-fit: cover; font-family: var(--font-ui, var(--font-display)); font-weight: 600; letter-spacing: 0; box-shadow: 0 0 0 1px var(--hairline); }
.kset-photo-text { display: grid; gap: 6px; min-width: 0; }
.kset-photo-acts { display: flex; flex-wrap: wrap; gap: 8px; }
.kset-photo-text .kset-hint { margin: 0; }
.kset-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 16px; }
.kset-field { min-width: 0; }
.kset-field[data-span="2"] { grid-column: 1 / -1; }
.kset-field > label { display: block; margin: 0 0 6px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kset-input {
  width: 100%; height: 40px; padding: 0 12px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); color: var(--ink);
  font: 500 14px/20px var(--font-ui, var(--font-display)); transition: border-color var(--d-1, 90ms) var(--ease);
}
.kset-input:hover:not(:disabled):not(:focus) { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kset-input::placeholder { color: var(--ink-4); opacity: 1; }
.kset-input:disabled { background: var(--fill-1); color: var(--ink-3); -webkit-text-fill-color: var(--ink-3); opacity: 1; cursor: default; }
.kset-input[aria-invalid="true"] { border-color: var(--signal, var(--prio-urgent)); }
.kset-input-mono { font-family: var(--font-mono); letter-spacing: 0.08em; }
.kset-input-wrap { position: relative; }
.kset-input-wrap .kset-input:disabled { padding-right: 40px; }
.kset-input-icon { position: absolute; right: 12px; top: 12px; color: var(--icon-quiet, var(--ink-4)); pointer-events: none; }
.kset-reveal {
  position: absolute; right: 6px; top: 6px; height: 28px; padding: 0 10px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-3); cursor: pointer; font: 600 12px/16px var(--font-ui, var(--font-display));
}
.kset-reveal:hover { background: var(--fill-1); color: var(--ink); }
.kset-hint { margin: 6px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kset-hint[data-tone="ok"] { color: var(--ok, var(--st-done)); }
.kset-hint[data-tone="signal"] { color: var(--signal, var(--prio-urgent)); }
.kset-hint-icon { display: flex; align-items: flex-start; gap: 6px; }
.kset-hint-icon > svg { flex-shrink: 0; margin-top: 1px; }
.kset-err { margin: 12px 0 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--signal, var(--prio-urgent)); }
.kset-done { display: flex; align-items: center; gap: 6px; margin: -4px 16px 12px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ok, var(--st-done)); }

/* inline panels (password form, confirmations) */
.kset-panel { display: grid; gap: 16px; margin: 0 16px 16px; padding: 16px; border-radius: var(--r-md, 8px); background: var(--fill-1); }
.kset-panel[data-tone="signal"] { background: var(--signal-tint, color-mix(in oklch, var(--prio-urgent) 8%, transparent)); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--signal, var(--prio-urgent)) 24%, transparent); }
.kset-panel .kset-err { margin: 0; }
.kset-panel-title { margin: 0; font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kset-panel-text { margin: 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kset-panel-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.kset-bullets { margin: 0; padding-left: 18px; display: grid; gap: 6px; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kset-bullets strong { font-weight: 600; color: var(--ink); }
.kset-link { padding: 0; border: 0; background: transparent; cursor: pointer; font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent)); text-decoration: underline; text-underline-offset: 2px; }
.kset .kbtn.kset-btn-signal { color: var(--signal, var(--prio-urgent)); }

/* profile save bar */
.kset-foot {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-height: 64px; padding: 12px 24px 12px 32px;
  border-top: 1px solid var(--hairline); background: var(--surface-raised);
  animation: ksetFoot var(--d-2, 160ms) var(--ease);
}
@keyframes ksetFoot { from { opacity: 0.35; translate: 0 6px; } }
.kset-foot-note { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kset-foot-note[data-tone="ok"] { color: var(--ok, var(--st-done)); font-weight: 600; }

/* ---- phones: full screen; the list pushes a section ---- */
.kset-mlist { display: flex; flex-direction: column; gap: 20px; }
.kset-me, .kset-mrow {
  display: flex; align-items: center; gap: 12px; width: 100%; border: 0; background: transparent; cursor: pointer; text-align: left;
  color: var(--ink); -webkit-tap-highlight-color: transparent; transition: background var(--d-1, 90ms) var(--ease);
}
.kset-me { min-height: 72px; padding: 12px 12px 12px 16px; border-radius: var(--r-lg, 12px); box-shadow: 0 0 0 1px var(--hairline-strong); }
.kset-me-text { display: grid; gap: 2px; flex: 1; min-width: 0; }
.kset-me-name { display: flex; align-items: center; gap: 8px; font: 600 15px/24px var(--font-ui, var(--font-display)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kset-me-sub { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kset-mgroup { border-radius: var(--r-lg, 12px); box-shadow: 0 0 0 1px var(--hairline-strong); overflow: hidden; }
.kset-mrow { position: relative; min-height: 52px; padding: 0 12px 0 16px; font: 500 14px/20px var(--font-ui, var(--font-display)); }
.kset-mrow > svg:first-child { color: var(--ink-3); }
.kset-mrow + .kset-mrow::before { content: ""; position: absolute; top: 0; left: 44px; right: 0; height: 1px; background: var(--hairline); }
.kset-mrow-label { flex: 1; min-width: 0; }
.kset-mrow-hint { font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kset-chev { color: var(--icon-quiet, var(--ink-4)); flex-shrink: 0; }
.kset-me:active, .kset-mrow:active { background: var(--fill-1); }
.kset-push { animation: ksetPush var(--d-3, 240ms) var(--ease); }
.kset-pop { animation: ksetPop var(--d-3, 240ms) var(--ease); }
@keyframes ksetPush { from { opacity: 0.35; translate: 24px 0; } }
@keyframes ksetPop { from { opacity: 0.35; translate: -24px 0; } }

@media (max-width: 859px) {
  .ksheet-layer.kset-layer { padding: 0; align-items: stretch; }
  .ksheet.kset {
    flex-direction: column; width: 100%; height: 100%; border-radius: 0; box-shadow: none; animation-name: ksheetUp;
    padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .kset-head { height: 52px; padding: 0 8px 0 16px; }
  .kset-head > .kibtn:first-child { margin-left: -8px; }
  .kset-scroll { padding: 8px 16px 32px; }
  .kset-foot { padding: 12px 16px; }
  .kset-fields { grid-template-columns: 1fr; }
  /* 16px stops iOS zooming into a field on focus */
  .kset-input { font-size: 16px; }
  .kset-row-ctl { margin-left: 0; }
  .kset-row[role="group"] .kset-row-ctl { width: 100%; }
  .kset-seg { max-width: 100%; }
  .kset-keys { columns: 1; }
  .kset-matrix th, .kset-matrix td { padding-left: 12px; }
  .kset-matrix thead th + th, .kset-matrix td { width: 56px; padding-left: 2px; padding-right: 2px; }
  .kset-panel { margin: 0 12px 12px; padding: 12px; }
}
@media (pointer: coarse) {
  .kset-swatch::before { content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; translate: -50% -50%; }
  .kset-check { width: 44px; height: 44px; }
  .kset-check input { top: 14px; left: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .kset-sec, .kset-push, .kset-pop, .kset-foot { animation: none !important; }
  .kset-swatch, .kset-tab, .kset-check-box { transition: none; }
}
`;

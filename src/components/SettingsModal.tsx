/* ============================================================
   KANBO — profile settings: name, pronouns, avatar, password & sign-in
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon, Collapse } from "./primitives";
import { memberInitials } from "../data/data";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { ACCENTS, accentSwatch, type Appearance, type TextSize } from "../lib/appearance";
import { AVATAR_ACCEPT, avatarObjectPath, prepareAvatarFile, removeAvatarObjects } from "../lib/avatarUpload";
import { PASSWORD_MIN, passwordIssue, friendlyPasswordError, friendlySignOutError } from "../lib/accountSecurity";

const PRONOUN_SUGGESTIONS = ["she/her", "he/him", "they/them", "she/they", "he/they", "ze/zir"];

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  pronouns: string;
  avatarUrl: string | null;
}

const inputStyle: React.CSSProperties = {
  width: "100%", height: 42, padding: "0 13px", borderRadius: 11, border: "1px solid var(--hairline)",
  background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 14, outline: "none",
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-3)", marginBottom: 6, letterSpacing: ".01em" };
const hintStyle: React.CSSProperties = { margin: "6px 0 0", fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.45 };
const rowTitle: React.CSSProperties = { display: "block", fontSize: 13.5, color: "var(--ink-2)", fontWeight: 500 };
const rowSub: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--ink-4)", lineHeight: 1.45, marginTop: 2 };
// text + button; the button drops below the text on a phone
const securityRow: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px 12px" };
const securityText: React.CSSProperties = { flex: "1 1 200px", minWidth: 0 };
const dangerPanel: React.CSSProperties = { padding: 14, borderRadius: 12, border: "1px solid color-mix(in oklch, var(--prio-urgent) 40%, transparent)", background: "color-mix(in oklch, var(--prio-urgent) 8%, transparent)" };
const dangerButton: React.CSSProperties = { background: "var(--danger-fill, var(--prio-urgent))", color: "#fff", border: "none" };

const NOTIF_ROWS: { key: string; label: string }[] = [
  { key: "assigned", label: "Assigned to me" },
  { key: "mention", label: "Mentions" },
  { key: "comment", label: "Comments on my tasks" },
  { key: "due", label: "Due-date reminders" },
];

const DELETE_WORD = "DELETE";
// Set in user_metadata once a Google-only account adds a password: Supabase
// doesn't add "email" to app_metadata.providers when it does.
const PASSWORD_SET_FLAG = "kanbo_password_set";

export function SettingsModal({ open, onClose, initial, email, color, onUpload, onSave, onExport, onDeleteAccount, notifyPrefs = {}, onSaveNotifyPrefs, appearance, onChangeAppearance }: {
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
}) {
  const auth = useAuth();
  const uid = auth.user?.id ?? null;
  // a pref is ON unless explicitly false (in-app key = base; email key = base+"_email")
  const prefOn = (k: string) => notifyPrefs[k] !== false;
  const togglePref = (k: string) => onSaveNotifyPrefs?.({ ...notifyPrefs, [k]: !prefOn(k) });
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [pronouns, setPronouns] = useState(initial.pronouns);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initial.avatarUrl);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
  const fileRef = useRef<HTMLInputElement>(null);
  const pwButtonRef = useRef<HTMLButtonElement>(null);
  const pwInputRef = useRef<HTMLInputElement>(null);
  const pw2InputRef = useRef<HTMLInputElement>(null);
  const signOutButtonRef = useRef<HTMLButtonElement>(null);
  const signOutCancelRef = useRef<HTMLButtonElement>(null);
  const signOutPanelRef = useRef<HTMLDivElement>(null);
  const pwFormRef = useRef<HTMLFormElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  // photos uploaded while the dialog is open that the profile doesn't point
  // at yet; removed from storage if they end up unused
  const uploadsRef = useRef<string[]>([]);
  // bumps on every open/close so a slow upload can tell it was abandoned
  const sessionRef = useRef(0);

  // closing without saving: the profile still points at the old photo, so
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
      setError(null);
    }
  }, [open, initial.firstName, initial.lastName, initial.pronouns, initial.avatarUrl]);

  // per-visit state starts fresh each time the dialog opens
  useEffect(() => {
    sessionRef.current++;
    if (!open) return;
    uploadsRef.current = [];
    setAvatarError(null); setUploading(false);
    setConfirmDelete(false); setDeleting(false); setDeleteWord(""); setDeleteError(null);
    setPwOpen(false); setPw(""); setPw2(""); setShowPw(false); setPwTried(false); setPwBusy(false); setPwError(null); setPwDone(null);
    setConfirmSignOut(false); setSigningOut(false); setSignOutError(null);
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

  if (!open) return null;

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const session = sessionRef.current;
    const replacing = avatarUrl;
    setAvatarError(null); setUploading(true);
    try {
      const ready = await prepareAvatarFile(file);
      const url = await onUpload(ready);
      if (session !== sessionRef.current) { void removeAvatarObjects([url], uid); return; } // dialog closed mid-upload
      // a photo uploaded earlier in this session is replaced before it was
      // ever saved: nothing points at it, so tidy it away now. The saved
      // photo is only removed once the profile is saved (Cancel keeps it).
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
  // so another tab or device may have changed it since this dialog opened
  // (and removed the one we were shown). undefined = couldn't tell.
  const storedAvatarUrl = async (): Promise<string | null | undefined> => {
    if (!supabase || !uid) return undefined;
    try {
      const { data, error: err } = await supabase.from("profiles").select("avatar_url").eq("id", uid).maybeSingle();
      if (err || !data) return undefined;
      return (data as { avatar_url: string | null }).avatar_url ?? null;
    } catch { return undefined; }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const stored = await storedAvatarUrl();
      // photo untouched here: keep whatever is stored now rather than
      // pointing the profile back at a photo another tab replaced
      const nextAvatar = avatarUrl === initial.avatarUrl && stored !== undefined ? stored : avatarUrl;
      await onSave({ firstName: firstName.trim(), lastName: lastName.trim(), pronouns: pronouns.trim(), avatarUrl: nextAvatar });
      // the profile now points at `nextAvatar`: the photo it replaced and any
      // other uploads from this session are unused
      const unused = [...uploadsRef.current, initial.avatarUrl, stored].filter((u) => u && u !== nextAvatar);
      uploadsRef.current = [];
      void removeAvatarObjects(unused, uid);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile.");
    } finally {
      setSaving(false);
    }
  };

  const longEnough = pw.length >= PASSWORD_MIN;
  const mismatch = pw2.length > 0 && pw2 !== pw && (pwTried || pw2.length >= pw.length);
  // submitted with the confirmation left empty
  const confirmMissing = pwTried && longEnough && pw2.length === 0;
  const confirmHint = mismatch ? "The two passwords don't match." : confirmMissing ? "Type your new password again to confirm it." : null;
  // after a panel swaps back to its trigger button, put focus on that button
  const focusSoon = (el: React.RefObject<HTMLElement>) => { window.setTimeout(() => el.current?.focus(), 0); };
  // Focus a control inside a Collapse once it has mounted. preventScroll stops
  // the browser scrolling the still-clipped panel (which made its content
  // jump while opening); once it's open, bring the panel into view.
  const focusInPanel = (el: React.RefObject<HTMLElement>, panel: React.RefObject<HTMLElement>) => {
    window.setTimeout(() => el.current?.focus({ preventScroll: true }), 30);
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
      if (avatarUrl && unused.includes(avatarUrl)) setAvatarUrl(initial.avatarUrl);
      setSignOutError(friendlySignOutError(err instanceof Error ? err.message : String(err)));
      setSigningOut(false);
    }
  };

  const deleteConfirmed = deleteWord.trim().toUpperCase() === DELETE_WORD;
  const deleteAccount = async () => {
    if (!deleteConfirmed || deleting) return;
    setDeleting(true); setDeleteError(null);
    // The face photo lives in a public bucket and doesn't go with the account,
    // so remove it (and anything uploaded in this visit) while this session
    // can. Only this person's own "<uid>/avatar-*" files are touched.
    const photos = [...uploadsRef.current, initial.avatarUrl, avatarUrl];
    uploadsRef.current = [];
    await removeAvatarObjects(photos, uid);
    try { await onDeleteAccount(); }
    catch (err) {
      const message = err instanceof Error && err.message ? err.message : "Couldn't delete your account.";
      setDeleting(false);
      if (avatarObjectPath(avatarUrl, uid)) setAvatarUrl(null);
      if (!avatarObjectPath(initial.avatarUrl, uid)) { setDeleteError(message); return; }
      // the account is still here but its saved photo is gone: stop the
      // profile pointing at it so nobody sees a broken image
      try { await onSave({ firstName: initial.firstName, lastName: initial.lastName, pronouns: initial.pronouns, avatarUrl: null }); } catch { /* shown below either way */ }
      setDeleteError(`${message} Your profile photo was already removed; you can add it again.`);
    }
  };

  const previewName = [firstName, lastName].filter(Boolean).join(" ") || email;
  const pwLabel = hasPassword === false ? "Set a password" : "Change password";

  return (
    <div onClick={dismiss} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 120, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10vh", overflowY: "auto" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Profile settings" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 460, maxWidth: "94vw", borderRadius: 20, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="settings" size={18} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>Your profile</span>
          <button className="btn-icon" onClick={dismiss} aria-label="Close" style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>

        <div style={{ padding: 22 }}>
          {/* avatar */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
            {avatarUrl ? (
              <img src={avatarUrl} alt="" style={{ width: 72, height: 72, borderRadius: 99, objectFit: "cover", boxShadow: "0 0 0 1.5px var(--bg)", flexShrink: 0 }} />
            ) : (
              <span aria-hidden="true" style={{ width: 72, height: 72, borderRadius: 99, display: "grid", placeItems: "center", flexShrink: 0, background: color, color: "var(--avatar-ink, currentColor)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 26 }}>
                {memberInitials(previewName)}
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} onChange={pickFile} style={{ display: "none" }} aria-label="Upload profile photo" />
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading} aria-busy={uploading || undefined}>
                <Icon name="user" size={15} /> {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Upload photo"}
              </button>
              {avatarUrl && !uploading && (
                <button onClick={() => { setAvatarError(null); setAvatarUrl(null); }} aria-label="Remove profile photo" style={{ marginLeft: 8, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 12.5, fontFamily: "var(--font-display)", padding: "4px 2px", borderRadius: 6 }}>Remove</button>
              )}
              {avatarError
                ? <p role="alert" style={{ ...hintStyle, margin: "8px 0 0", color: "var(--prio-urgent)" }}>{avatarError}</p>
                : <p style={{ ...hintStyle, margin: "8px 0 0" }}>PNG, JPG, GIF or WebP, up to 5 MB</p>}
            </div>
          </div>

          {/* names */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label htmlFor="kanbo-first" style={labelStyle}>First name</label>
              <input id="kanbo-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Daniel" autoComplete="given-name" style={inputStyle} />
            </div>
            <div>
              <label htmlFor="kanbo-last" style={labelStyle}>Surname</label>
              <input id="kanbo-last" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Chappell" autoComplete="family-name" style={inputStyle} />
            </div>
          </div>

          {/* pronouns */}
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="kanbo-pronouns" style={labelStyle}>Pronouns</label>
            <input id="kanbo-pronouns" list="kanbo-pronoun-options" value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="they/them" style={inputStyle} />
            <datalist id="kanbo-pronoun-options">
              {PRONOUN_SUGGESTIONS.map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>

          {/* email (read-only) */}
          <div>
            <label htmlFor="kanbo-email" style={labelStyle}>Email</label>
            <div style={{ position: "relative" }}>
              <input id="kanbo-email" value={email} readOnly disabled style={{ ...inputStyle, color: "var(--ink-4)", paddingRight: 38 }} />
              <Icon name="lock" size={14} style={{ position: "absolute", right: 13, top: 14, color: "var(--ink-4)" }} />
            </div>
            <p style={hintStyle}>Your sign-in email can't be changed here.</p>
          </div>

          {error && <div role="alert" style={{ marginTop: 14, fontSize: 12.5, color: "var(--prio-urgent)" }}>{error}</div>}

          {/* password & sign-in */}
          <div className="divider" style={{ margin: "22px 0 16px" }} />
          <h3 style={labelStyle}>Password &amp; sign-in</h3>
          <div style={securityRow}>
            <span style={securityText}>
              <span style={rowTitle}>Password</span>
              <span style={rowSub}>
                {hasPassword === false ? "You sign in with Google. Add a password to sign in with your email too." : "Change the password you use to sign in."}
              </span>
            </span>
            {!pwOpen && (
              <button ref={pwButtonRef} className="btn btn-ghost" onClick={openPassword} style={{ flexShrink: 0 }}>
                <Icon name="lock" size={15} /> {pwLabel}
              </button>
            )}
          </div>
          <div role="status">
            {pwDone && !pwOpen && (
              <p style={{ ...hintStyle, marginTop: 8, color: "var(--st-done)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name="check" size={14} /> {pwDone}
              </p>
            )}
          </div>
          <Collapse open={pwOpen}>
            <form ref={pwFormRef} onSubmit={changePassword} noValidate aria-label={pwLabel}
              style={{ marginTop: 12, padding: 14, borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--fill-1, var(--surface))" }}>
              {/* lets password managers file the new password under the right account */}
              <input type="email" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" style={{ display: "none" }} />
              <label htmlFor="kanbo-new-password" style={labelStyle}>New password</label>
              <div style={{ position: "relative" }}>
                <input ref={pwInputRef} id="kanbo-new-password" name="new-password" type={showPw ? "text" : "password"} autoComplete="new-password"
                  value={pw} onChange={(e) => { setPw(e.target.value); setPwError(null); }}
                  aria-invalid={pwTried && !longEnough ? true : undefined} aria-describedby="kanbo-new-password-hint"
                  style={{ ...inputStyle, paddingRight: 66 }} />
                <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw} aria-label={showPw ? "Hide passwords" : "Show passwords"}
                  style={{ position: "absolute", right: 6, top: 7, height: 28, padding: "0 10px", borderRadius: 8, border: "none", background: "transparent", color: "var(--ink-3)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 600 }}>
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
              <p id="kanbo-new-password-hint" style={{ ...hintStyle, display: "flex", alignItems: "flex-start", gap: 6, color: longEnough ? "var(--st-done)" : pwTried ? "var(--prio-urgent)" : "var(--ink-4)" }}>
                <Icon name={longEnough ? "check" : "dot"} size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>At least {PASSWORD_MIN} characters. A short phrase is easy to remember and hard to guess.</span>
              </p>
              <label htmlFor="kanbo-confirm-password" style={{ ...labelStyle, marginTop: 14 }}>Confirm new password</label>
              <input ref={pw2InputRef} id="kanbo-confirm-password" name="confirm-password" type={showPw ? "text" : "password"} autoComplete="new-password"
                value={pw2} onChange={(e) => { setPw2(e.target.value); setPwError(null); }}
                aria-invalid={confirmHint ? true : undefined} aria-describedby={confirmHint ? "kanbo-confirm-password-hint" : undefined}
                style={inputStyle} />
              {confirmHint && <p id="kanbo-confirm-password-hint" style={{ ...hintStyle, color: "var(--prio-urgent)" }}>{confirmHint}</p>}
              {pwError && <p role="alert" style={{ ...hintStyle, marginTop: 10, color: "var(--prio-urgent)", fontSize: 12.5 }}>{pwError}</p>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
                <button type="button" className="btn btn-ghost" onClick={closePassword} disabled={pwBusy}>Cancel</button>
                <button type="submit" className="btn btn-accent" disabled={pwBusy} aria-busy={pwBusy || undefined} style={{ opacity: pwBusy ? 0.6 : 1 }}>
                  <Icon name="check" size={15} /> {pwBusy ? "Updating…" : hasPassword === false ? "Set password" : "Update password"}
                </button>
              </div>
            </form>
          </Collapse>

          {/* demo mode has no sessions to end (App hides Sign out there too) */}
          {auth.configured && (
            <>
              <div style={{ ...securityRow, marginTop: 16 }}>
                <span style={securityText}>
                  <span style={rowTitle}>Sign out of all devices</span>
                  <span style={rowSub}>Lost a laptop or phone, or used a shared computer? End every session, including this one.</span>
                </span>
                {!confirmSignOut && (
                  <button ref={signOutButtonRef} className="btn btn-ghost" onClick={openSignOut} style={{ flexShrink: 0 }}>
                    <Icon name="logout" size={15} /> Sign out everywhere
                  </button>
                )}
              </div>
              <Collapse open={confirmSignOut}>
                <div ref={signOutPanelRef} role="group" aria-label="Confirm signing out of all devices" style={{ marginTop: 12, padding: 14, borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--fill-1, var(--surface))" }}>
                  <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)" }}>
                    You'll be signed out on every browser and device, including this one. Other devices lose access within the hour at the latest. Your work isn't affected.
                  </p>
                  {signOutError && <p role="alert" style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--prio-urgent)" }}>{signOutError}</p>}
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button ref={signOutCancelRef} className="btn btn-ghost" onClick={() => { setConfirmSignOut(false); focusSoon(signOutButtonRef); }} disabled={signingOut}>Cancel</button>
                    <button className="btn btn-accent" onClick={signOutEverywhere} disabled={signingOut} aria-busy={signingOut || undefined} style={{ opacity: signingOut ? 0.6 : 1 }}>
                      <Icon name="logout" size={15} /> {signingOut ? "Signing out…" : "Sign out everywhere"}
                    </button>
                  </div>
                </div>
              </Collapse>
            </>
          )}

          {/* appearance */}
          {appearance && onChangeAppearance && (
            <>
              <div className="divider" style={{ margin: "22px 0 16px" }} />
              <label style={labelStyle}>Appearance</label>
              <div style={{ marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: "var(--ink-4)", display: "block", marginBottom: 8 }}>Accent colour</span>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {ACCENTS.map((a) => {
                    const active = appearance.accent === a.id;
                    return (
                      <button key={a.id} onClick={() => onChangeAppearance({ ...appearance, accent: a.id })} title={a.label} aria-label={a.label}
                        style={{ width: 30, height: 30, borderRadius: 9, background: accentSwatch(a.id), cursor: "pointer", border: active ? "2px solid var(--ink)" : "2px solid transparent", boxShadow: active ? "0 0 0 2px var(--surface-raised), 0 0 12px " + accentSwatch(a.id) : "none", display: "grid", placeItems: "center" }}>
                        {active && <Icon name="check" size={15} style={{ color: "#fff" }} />}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "var(--ink-4)", display: "block", marginBottom: 8 }}>Text size</span>
                <div style={{ display: "inline-flex", borderRadius: 10, border: "1px solid var(--hairline)", overflow: "hidden" }}>
                  {(["small", "normal", "large"] as TextSize[]).map((s) => {
                    const active = appearance.textSize === s;
                    return (
                      <button key={s} onClick={() => onChangeAppearance({ ...appearance, textSize: s })}
                        style={{ padding: "7px 16px", border: "none", background: active ? "var(--accent)" : "transparent", color: active ? "var(--on-accent)" : "var(--ink-2)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: s === "small" ? 12 : s === "large" ? 15 : 13.5, fontWeight: 500, textTransform: "capitalize" }}>
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={appearance.ambient} onChange={() => onChangeAppearance({ ...appearance, ambient: !appearance.ambient })} style={{ marginTop: 3, cursor: "pointer" }} />
                <span>
                  <span style={{ display: "block", fontSize: 13.5, color: "var(--ink-2)" }}>Ambient motion</span>
                  <span style={{ display: "block", fontSize: 12, color: "var(--ink-4)", lineHeight: 1.45 }}>The background glow drifts slowly. Uses a little more battery on laptops.</span>
                </span>
              </label>
            </>
          )}

          {/* your data */}
          <div className="divider" style={{ margin: "22px 0 16px" }} />
          <label style={labelStyle}>Your data</label>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-ghost" onClick={onExport}><Icon name="archive" size={15} /> Export my data</button>
            <span style={{ fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.4 }}>Download all your tasks and projects as a JSON file.</span>
          </div>

          {/* notifications */}
          {onSaveNotifyPrefs && (
            <>
              <div className="divider" style={{ margin: "22px 0 16px" }} />
              <label style={labelStyle}>Notifications</label>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                <span style={{ flex: 1 }} />
                <span className="kicker" style={{ width: 56, textAlign: "center" }}>In-app</span>
                <span className="kicker" style={{ width: 56, textAlign: "center" }}>Email</span>
              </div>
              {NOTIF_ROWS.map((r) => (
                <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0", borderTop: "1px solid var(--hairline)" }}>
                  <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-2)" }}>{r.label}</span>
                  {/* due reminders are email-only (sent by the daily job) */}
                  <span style={{ width: 56, display: "grid", placeItems: "center" }}>
                    {r.key === "due" ? <span style={{ color: "var(--ink-4)", fontSize: 16 }}>—</span>
                      : <input type="checkbox" checked={prefOn(r.key)} onChange={() => togglePref(r.key)} aria-label={`${r.label} in-app`} style={{ cursor: "pointer" }} />}
                  </span>
                  <span style={{ width: 56, display: "grid", placeItems: "center" }}>
                    <input type="checkbox" checked={prefOn(`${r.key}_email`)} onChange={() => togglePref(`${r.key}_email`)} aria-label={`${r.label} email`} style={{ cursor: "pointer" }} />
                  </span>
                </div>
              ))}
            </>
          )}

          {/* danger zone */}
          <div className="divider" style={{ margin: "22px 0 16px" }} />
          <label style={{ ...labelStyle, color: "var(--prio-urgent)" }}>Danger zone</label>
          {!confirmDelete ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button ref={deleteButtonRef} onClick={() => { setDeleteError(null); setDeleteWord(""); setConfirmDelete(true); }} className="btn btn-ghost" style={{ color: "var(--prio-urgent)", borderColor: "color-mix(in oklch, var(--prio-urgent) 40%, transparent)", flexShrink: 0 }}>
                <Icon name="trash" size={15} /> Delete account
              </button>
              <span style={{ fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.4 }}>Deletes your account and personal work. Team work stays with your team.</span>
            </div>
          ) : (
            <div role="group" aria-labelledby="kanbo-delete-title" style={dangerPanel}>
              <p id="kanbo-delete-title" style={{ margin: "0 0 8px", fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                Delete your account? This can't be undone.
              </p>
              <ul style={{ margin: "0 0 12px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
                <li><strong>Deleted for good:</strong> your profile, your profile photo, and your personal tasks and projects.</li>
                <li><strong>Kept for your team:</strong> tasks and projects you created in team workspaces stay where they are. Your comments stay too, still showing your name.</li>
                <li><strong>Workspaces you own</strong> pass to their next admin or, if there isn't one, to the longest-standing person left in the workspace. A workspace with nobody else in it is deleted.</li>
              </ul>
              <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
                Want a copy first?{" "}
                <button onClick={onExport} style={{ border: "none", background: "transparent", padding: 0, color: "var(--accent-text, var(--accent))", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5, fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2 }}>Export my data</button>
              </p>
              <label htmlFor="kanbo-delete-confirm" style={{ ...labelStyle, color: "var(--ink-2)" }}>Type {DELETE_WORD} to confirm</label>
              <input id="kanbo-delete-confirm" autoFocus value={deleteWord} onChange={(e) => setDeleteWord(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={deleting}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void deleteAccount(); } }}
                style={{ ...inputStyle, height: 38, marginBottom: 12, fontFamily: "var(--font-mono)", letterSpacing: ".08em" }} />
              {deleteError && <p role="alert" style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--prio-urgent)" }}>{deleteError}</p>}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={() => { setConfirmDelete(false); setDeleteWord(""); setDeleteError(null); focusSoon(deleteButtonRef); }} disabled={deleting}>Cancel</button>
                <button onClick={deleteAccount} disabled={!deleteConfirmed || deleting} aria-busy={deleting || undefined} className="btn"
                  style={{ ...dangerButton, opacity: !deleteConfirmed || deleting ? 0.55 : 1, cursor: !deleteConfirmed || deleting ? "not-allowed" : "pointer" }}>
                  <Icon name="trash" size={15} /> {deleting ? "Deleting…" : "Delete forever"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)" }}>
          <button className="btn btn-ghost" onClick={dismiss}>Cancel</button>
          <button className="btn btn-accent" onClick={save} disabled={saving || uploading} style={{ opacity: saving || uploading ? 0.6 : 1 }}>
            <Icon name="check" size={15} /> {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

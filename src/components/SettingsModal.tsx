/* ============================================================
   KANBO — profile settings: name, pronouns, avatar
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon } from "./primitives";
import { memberInitials } from "../data/data";
import { useFocusTrap } from "../hooks/useFocusTrap";

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

const NOTIF_ROWS: { key: string; label: string }[] = [
  { key: "assigned", label: "Assigned to me" },
  { key: "mention", label: "Mentions" },
  { key: "comment", label: "Comments on my tasks" },
  { key: "due", label: "Due-date reminders" },
];

export function SettingsModal({ open, onClose, initial, email, color, onUpload, onSave, onExport, onDeleteAccount, notifyPrefs = {}, onSaveNotifyPrefs }: {
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
}) {
  // a pref is ON unless explicitly false (in-app key = base; email key = base+"_email")
  const prefOn = (k: string) => notifyPrefs[k] !== false;
  const togglePref = (k: string) => onSaveNotifyPrefs?.({ ...notifyPrefs, [k]: !prefOn(k) });
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [pronouns, setPronouns] = useState(initial.pronouns);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initial.avatarUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) {
      setFirstName(initial.firstName); setLastName(initial.lastName);
      setPronouns(initial.pronouns); setAvatarUrl(initial.avatarUrl);
      setError(null); setConfirmDelete(false); setDeleting(false);
    }
  }, [open, initial.firstName, initial.lastName, initial.pronouns, initial.avatarUrl]);

  if (!open) return null;

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Please choose an image file."); return; }
    if (file.size > 5 * 1024 * 1024) { setError("Image must be under 5 MB."); return; }
    setError(null); setUploading(true);
    try {
      const url = await onUpload(file);
      setAvatarUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await onSave({ firstName: firstName.trim(), lastName: lastName.trim(), pronouns: pronouns.trim(), avatarUrl });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile.");
    } finally {
      setSaving(false);
    }
  };

  const previewName = [firstName, lastName].filter(Boolean).join(" ") || email;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 120, background: "color-mix(in oklch, var(--bg-deep) 60%, transparent)", backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "10vh", overflowY: "auto" }}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Profile settings" onClick={(e) => e.stopPropagation()} className="glass anim-scalein" style={{ width: 460, maxWidth: "94vw", borderRadius: 20, overflow: "hidden", background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 18px", borderBottom: "1px solid var(--hairline)" }}>
          <Icon name="settings" size={18} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>Your profile</span>
          <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto", border: "none", width: 30, height: 30 }}><Icon name="x" size={17} /></button>
        </div>

        <div style={{ padding: 22 }}>
          {/* avatar */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 22 }}>
            {avatarUrl ? (
              <img src={avatarUrl} alt="" style={{ width: 72, height: 72, borderRadius: 99, objectFit: "cover", boxShadow: "0 0 0 1.5px var(--bg)" }} />
            ) : (
              <span style={{ width: 72, height: 72, borderRadius: 99, display: "grid", placeItems: "center", background: color, color: "var(--bg-deep)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 26 }}>
                {memberInitials(previewName)}
              </span>
            )}
            <div style={{ flex: 1 }}>
              <input ref={fileRef} type="file" accept="image/*" onChange={pickFile} style={{ display: "none" }} aria-label="Upload profile picture" />
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={uploading}>
                <Icon name="user" size={15} /> {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Upload photo"}
              </button>
              {avatarUrl && !uploading && (
                <button onClick={() => setAvatarUrl(null)} style={{ marginLeft: 8, border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 12.5, fontFamily: "var(--font-display)" }}>Remove</button>
              )}
              <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--ink-4)" }}>JPG, PNG or GIF · up to 5 MB</p>
            </div>
          </div>

          {/* names */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label htmlFor="kanbo-first" style={labelStyle}>First name</label>
              <input id="kanbo-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Daniel" style={inputStyle} />
            </div>
            <div>
              <label htmlFor="kanbo-last" style={labelStyle}>Surname</label>
              <input id="kanbo-last" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Chappell" style={inputStyle} />
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
            <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--ink-4)" }}>Your sign-in email can't be changed here.</p>
          </div>

          {error && <div role="alert" style={{ marginTop: 14, fontSize: 12.5, color: "var(--prio-urgent)" }}>{error}</div>}

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
              <button onClick={() => { setError(null); setConfirmDelete(true); }} className="btn btn-ghost" style={{ color: "var(--prio-urgent)", borderColor: "color-mix(in oklch, var(--prio-urgent) 40%, transparent)" }}>
                <Icon name="trash" size={15} /> Delete account
              </button>
              <span style={{ fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.4 }}>Permanently removes your account and all data.</span>
            </div>
          ) : (
            <div style={{ padding: 14, borderRadius: 12, border: "1px solid color-mix(in oklch, var(--prio-urgent) 40%, transparent)", background: "color-mix(in oklch, var(--prio-urgent) 8%, transparent)" }}>
              <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)" }}>
                This <strong>permanently</strong> deletes your account, tasks, projects, and comments. This can't be undone.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
                <button onClick={async () => {
                  setDeleting(true); setError(null);
                  try { await onDeleteAccount(); }
                  catch (err) { setError(err instanceof Error ? err.message : "Couldn't delete your account."); setDeleting(false); }
                }} disabled={deleting} className="btn" style={{ background: "var(--prio-urgent)", color: "#fff", border: "none", opacity: deleting ? 0.6 : 1 }}>
                  <Icon name="trash" size={15} /> {deleting ? "Deleting…" : "Delete forever"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "14px 18px", borderTop: "1px solid var(--hairline)" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={save} disabled={saving || uploading} style={{ opacity: saving || uploading ? 0.6 : 1 }}>
            <Icon name="check" size={15} /> {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

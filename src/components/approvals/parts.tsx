/* ============================================================
   KANBO — approvals: small shared pieces (a person's disc that copes
   with someone the app hasn't loaded, relative time with the full date
   on hover, the live-region / toast announcer).            [0047 · w4]
   ============================================================ */
import { useCallback, useState } from "react";
import { Avatar } from "../primitives";
import { getMember, timeAgo } from "../../data/data";
import { useOptionalToast } from "../rituals/shared";

const fullFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const fullDate = (iso: string | null | undefined): string | undefined => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? fullFmt.format(t) : undefined;
};

/** "2h ago", with the full date and time on hover and for assistive tech. */
export function When({ iso, className = "kapv-time" }: { iso: string | null | undefined; className?: string }) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return <time className={className} dateTime={iso} title={fullDate(iso)}>{timeAgo(iso)}</time>;
}

const initials = (name: string) => {
  const n = name.trim();
  if (!n) return "?";
  if (n.includes("@")) return n[0].toUpperCase();
  return n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
};

/** A person's avatar (the app's own disc when it knows them, else their initials). Decorative: the name is always written beside it. */
export function PersonMark({ id, name, size = 24 }: { id: string | null | undefined; name: string | null | undefined; size?: 20 | 24 | 28 }) {
  if (id && getMember(id)) return <span className="kapv-av" data-kind="avatar" aria-hidden="true" style={{ width: size, height: size }}><Avatar id={id} size={size} /></span>;
  return <span className="kapv-av" aria-hidden="true" style={{ width: size, height: size, fontSize: size >= 28 ? 12 : 10 }}>{initials(name ?? "")}</span>;
}

/** Say what happened: a toast when the app has its toast stack (it's a live region), else a polite
 *  region of our own (`message` → render it in `<p className="sr-only" aria-live="polite">`). */
export function useAnnounce(): { say: (text: string, tone?: "success" | "info" | "error") => void; message: string } {
  const toast = useOptionalToast();
  const [message, setMessage] = useState("");
  const say = useCallback((text: string, tone: "success" | "info" | "error" = "success") => {
    if (toast) {
      if (tone === "success") toast.success(text);
      else if (tone === "error") toast.error(text);
      else toast.toast(text);
      return;
    }
    // re-announce the same words: clear first
    setMessage("");
    window.setTimeout(() => setMessage(text), 30);
  }, [toast]);
  return { say, message };
}

/** Grow a textarea with its text (up to the CSS max-height). */
export function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(160, Math.max(36, el.scrollHeight + 2))}px`;
}

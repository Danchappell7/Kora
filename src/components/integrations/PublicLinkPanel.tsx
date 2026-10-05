/* ============================================================
   KANBO — a form's public link.                             [f9-public-forms]
   "Anyone with the link can submit" toggle, the link (copy, open), a QR
   code (lib/qr, pure SVG; download as SVG) and "Regenerate link"
   (confirm: the old link stops working). Read-only for people who can't
   edit the form (guests): they see the link only while it's on. Demo:
   toggles locally and links to /f/demo. Before 0043: explains it isn't
   switched on yet; before the public-form function is deployed: says the
   page isn't live yet.
   Mount (integrator): in the Forms / Requests UI (RulesForms' FormsView,
   the project Requests tab), inside each form's card:
     <PublicLinkPanel form={f} canEdit={!readOnly} projectName={proj?.name}
       onChange={(p) => setForms((fs) => fs.map((x) => x.id === f.id ? { ...x, ...p } : x))} />
   ============================================================ */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FormDef } from "../../data/types";
import { Button, Icon, Pill, Toggle } from "../primitives";
import { copyText, useOptionalToast } from "../rituals/shared";
import { encodeQr, qrPath, qrSvg } from "../../lib/qr";
import {
  DEMO_PUBLIC_TOKEN, publicFormUrl, publicLinksStatus, regenerateFormLink, setFormPublic,
  PublicLinkError, type PublicLinksStatus,
} from "../../lib/publicForms";
import "./publicLink.css";

export interface PublicLinkPanelProps {
  form: FormDef;
  /** may switch it / regenerate it (owner, admin, member; never guests) */
  canEdit: boolean;
  /** the project's name, for the QR download's file name and alt text */
  projectName?: string;
  /** the form's new public state, so the host updates its list */
  onChange?: (patch: { publicEnabled: boolean; publicToken: string | null }) => void;
}

/** QR colours: always dark on white, in both themes (inverted codes don't scan everywhere). */
const QR_DARK = "#0B1020";
const QR_LIGHT = "#FFFFFF";
const COPIED_MS = 2000;

const slug = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
/** "q3-product-launch-launch-requests-qr.svg" */
export function qrFileName(formName: string, projectName?: string): string {
  return [slug(projectName ?? ""), slug(formName), "qr"].filter(Boolean).join("-") + ".svg";
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

export function PublicLinkPanel({ form, canEdit, projectName, onChange }: PublicLinkPanelProps) {
  const toast = useOptionalToast();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (k: string) => `kpubl-${uid}-${k}`;

  const [enabled, setEnabled] = useState(!!form.publicEnabled);
  const [token, setToken] = useState<string | null>(form.publicToken ?? null);
  const [status, setStatus] = useState<PublicLinksStatus | null>(null);
  // a save that found 0043 missing outranks any (cached) probe that said otherwise
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "regenerate" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [said, setSaid] = useState("");

  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const regenRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    const ts = timers.current;
    return () => { alive.current = false; ts.forEach((t) => window.clearTimeout(t)); };
  }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(() => { if (alive.current) fn(); }, ms)); };

  // the host's list changed (realtime, another tab, a save): follow it
  useEffect(() => {
    setEnabled(!!form.publicEnabled);
    setToken(form.publicToken ?? null);
  }, [form.id, form.publicEnabled, form.publicToken]);

  // is it all switched on? (0043 for the toggle; the function for the page, once there's a link)
  useEffect(() => {
    let live = true;
    publicLinksStatus({ checkPage: enabled }).then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [enabled]);

  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  // focus moves happen after React has committed what they point at (Regenerate is
  // hidden while its confirmation is open; the field and Copy are always there)
  const [focusReq, setFocusReq] = useState<{ to: "regen" | "copy" | "input"; n: number } | null>(null);
  const focusOn = (to: "regen" | "copy" | "input") => setFocusReq((p) => ({ to, n: (p?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focusReq) return;
    if (focusReq.to === "input") { inputRef.current?.focus(); inputRef.current?.select(); }
    else (focusReq.to === "regen" ? regenRef.current : copyRef.current)?.focus();
  }, [focusReq]);

  const demo = status?.links === "demo";
  const unavailable = missing || status?.links === "unavailable";
  const linkToken = demo ? DEMO_PUBLIC_TOKEN : token;
  const url = enabled && linkToken ? publicFormUrl(linkToken) : null;
  const pending = form.id.startsWith("tmp-");

  const announce = useCallback((msg: string, kind: "success" | "error" = "success") => {
    if (toast) { if (kind === "error") toast.error(msg); else toast.success(msg); } else setSaid(msg);
  }, [toast]);

  const qr = useMemo(() => {
    if (!url) return null;
    try { return qrPath(encodeQr(url, "M"), 4); } catch { return null; }
  }, [url]);

  /* ---------------- actions ---------------- */

  const toggle = async (next: boolean) => {
    if (!canEdit || busy) return;
    setProblem(null);
    setConfirming(false);
    const before = enabled;
    setEnabled(next); // optimistic
    setBusy("toggle");
    try {
      const r = await setFormPublic(form.id, next);
      if (!alive.current) return;
      setEnabled(r.publicEnabled);
      setToken(r.publicToken);
      onChange?.(r);
      setSaid(r.publicEnabled ? "Public link on. Anyone with the link can send a request." : "Public link off. The link no longer opens the form.");
    } catch (e) {
      if (!alive.current) return;
      setEnabled(before);
      if (e instanceof PublicLinkError && e.code === "unavailable") setMissing(true);
      else setProblem((e as Error)?.message || "That didn't save. Try again in a moment.");
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const copy = async () => {
    if (!url) return;
    setCopyFailed(false);
    const ok = await copyText(url);
    if (!alive.current) return;
    if (ok) {
      setCopied(true);
      later(() => setCopied(false), COPIED_MS);
      announce("Link copied");
    } else {
      // no clipboard: select the link and say how to copy it by hand
      setCopyFailed(true);
      focusOn("input");
    }
  };

  const download = () => {
    if (!url) return;
    try {
      const svg = qrSvg(url, { ecc: "M", title: `QR code for ${form.name}${projectName ? ` (${projectName})` : ""}`, dark: QR_DARK, light: QR_LIGHT });
      const href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const a = document.createElement("a");
      a.href = href;
      a.download = qrFileName(form.name, projectName);
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setSaid("QR code downloaded");
    } catch {
      announce("The QR code couldn't be downloaded. Try again.", "error");
    }
  };

  const closeConfirm = () => {
    setConfirming(false);
    focusOn("regen");
  };

  const regenerate = async () => {
    if (!canEdit || busy || demo) return;
    setProblem(null);
    setBusy("regenerate");
    try {
      const next = await regenerateFormLink(form.id);
      if (!alive.current) return;
      setToken(next);
      setConfirming(false);
      setCopied(false);
      setFresh(true);
      later(() => setFresh(false), 1600);
      onChange?.({ publicEnabled: enabled, publicToken: next });
      announce("New link ready. The old link and QR code no longer work.");
      focusOn("copy");
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof PublicLinkError && e.code === "unavailable") { setMissing(true); setConfirming(false); }
      else setProblem((e as Error)?.message || "The link wasn't changed. Try again.");
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const onConfirmKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    // Escape backs out of the confirmation only, not a sheet or page around it
    e.preventDefault();
    e.stopPropagation();
    if (!busy) closeConfirm();
  };

  /* ---------------- not available ---------------- */

  if (unavailable) {
    if (!canEdit) return null;
    return (
      <section className="kpubl" data-state="unavailable" aria-label={`Public link for ${form.name}`}>
        <div className="kpubl-row">
          <span className="kpubl-icon" aria-hidden="true"><Icon name="link" size={16} sw={1.75} /></span>
          <div className="kpubl-text">
            <p className="kpubl-title">Public link</p>
            <p className="kpubl-desc">Public links aren't switched on for Kanbo yet. Once they are, you can let anyone with a link send requests here.</p>
          </div>
        </div>
      </section>
    );
  }

  // people who can't edit only ever see a link that's on
  if (!canEdit && !url) return null;

  const keyHint = isMac() ? "⌘C" : "Ctrl+C";
  const pageMissing = !demo && enabled && status?.page === "missing";

  return (
    <section className="kpubl" data-state={enabled ? "on" : "off"} aria-label={`Public link for ${form.name}`} aria-busy={busy ? true : undefined}>
      {canEdit ? (
        <Toggle
          checked={enabled}
          onChange={(v) => { void toggle(v); }}
          disabled={!!busy || pending}
          label="Anyone with the link can submit"
          description={pending
            ? "Available once the form has finished saving."
            : "People outside your team can send requests here without an account. Each one becomes a task for the project's owner, and runs the project's rules."}
        />
      ) : (
        <div className="kpubl-row">
          <span className="kpubl-icon" aria-hidden="true"><Icon name="link" size={16} sw={1.75} /></span>
          <div className="kpubl-text">
            <p className="kpubl-title">Anyone with the link can submit <Pill tone="ok">On</Pill></p>
            <p className="kpubl-desc">Only members can switch this link off or make a new one.</p>
          </div>
        </div>
      )}

      {url && (
        <div className="kpubl-body" id={id("body")}>
          <div className="kpubl-field" data-fresh={fresh || undefined}>
            <label className="sr-only" htmlFor={id("url")}>Public link to {form.name}</label>
            <input id={id("url")} ref={inputRef} className="kpubl-input" type="text" readOnly value={url} spellCheck={false}
              onFocus={(e) => e.currentTarget.select()} aria-describedby={copyFailed ? id("copyhint") : undefined} />
            <Button ref={copyRef} variant="secondary" icon={copied ? "check" : "copy"} onClick={() => { void copy(); }}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <a className="kbtn kpubl-open" data-variant="ghost" data-size="md" href={url} target="_blank" rel="noopener noreferrer">
              <span className="kbtn-label">Open</span>
              <Icon name="arrowUpRight" size={16} sw={1.75} />
              <span className="sr-only"> the form (opens in a new tab)</span>
            </a>
          </div>
          {copyFailed && <p id={id("copyhint")} className="kpubl-hint">Your browser didn't let Kanbo copy it. The link is selected: press {keyHint} to copy it.</p>}

          <div className="kpubl-actions">
            <Button size="sm" variant="ghost" aria-expanded={qrOpen} aria-controls={id("qr")} onClick={() => setQrOpen((o) => !o)}
              iconRight={qrOpen ? "chevronDown" : "chevronRight"}>
              QR code
            </Button>
            {canEdit && !demo && !confirming && (
              <Button ref={regenRef} size="sm" variant="ghost" icon="refresh" onClick={() => { setProblem(null); setConfirming(true); }} disabled={!!busy}>
                Regenerate link
              </Button>
            )}
          </div>

          {qrOpen && (
            <div className="kpubl-qr" id={id("qr")}>
              {qr ? (
                <svg className="kpubl-qr-img" viewBox={qr.viewBox} role="img" aria-label={`QR code that opens the ${form.name} form`} shapeRendering="crispEdges">
                  <rect width={qr.size} height={qr.size} fill={QR_LIGHT} />
                  <path d={qr.d} fill={QR_DARK} />
                </svg>
              ) : (
                <p className="kpubl-hint">This link is too long for a QR code.</p>
              )}
              <div className="kpubl-qr-text">
                <p className="kpubl-desc">Put it on a poster, a slide or a desk sign: scanning it opens the form.{canEdit && !demo ? " If you regenerate the link, download it again." : ""}</p>
                {qr && <Button size="sm" variant="secondary" onClick={download}>Download SVG</Button>}
              </div>
            </div>
          )}

          {confirming && (
            <div className="kpubl-confirm" role="group" aria-labelledby={id("ct")} aria-describedby={id("cx")} onKeyDown={onConfirmKey}>
              <p id={id("ct")} className="kpubl-confirm-title">Regenerate the link?</p>
              <p id={id("cx")} className="kpubl-confirm-text">The current link and QR code stop working straight away. Anyone you've shared them with will need the new one.</p>
              <div className="kpubl-confirm-acts">
                <Button ref={cancelRef} size="sm" variant="ghost" onClick={closeConfirm} disabled={busy === "regenerate"}>Cancel</Button>
                <Button size="sm" variant="danger" icon="refresh" loading={busy === "regenerate"} onClick={() => { void regenerate(); }}>Regenerate link</Button>
              </div>
            </div>
          )}

          {demo && <p className="kpubl-note"><Icon name="eye" size={14} sw={1.75} /><span>In the demo every form opens the same example page, so there's no link to regenerate.</span></p>}
          {pageMissing && (
            <p className="kpubl-note" data-tone="warn"><Icon name="alert" size={14} sw={1.75} /><span>The public page isn't live yet, so this link won't open until it is. There's nothing you need to do.</span></p>
          )}
        </div>
      )}

      {canEdit && !enabled && token && !demo && (
        <p className="kpubl-note">The link is off. Switching it back on brings back the same link.</p>
      )}
      {problem && <p className="kpubl-err" role="alert"><Icon name="alert" size={14} sw={2} /><span>{problem}</span></p>}
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
    </section>
  );
}

/* ============================================================
   KANBO — the public request form page, /f/:token.        [f9-public-forms]
   Rendered by main.tsx BEFORE auth (no AuthProvider, no App): anyone with
   the link can submit a request into the project's form. Branded with the
   project's cover / tile, Paper theme by default and system dark
   respected, mobile-first, accessible; states: loading, form, sending,
   thank-you (with the reference), disabled, not found, rate-limited,
   offline. /f/demo previews it with demo data (no network).

   Accessibility: every field has a visible label, a hint where it helps
   and its error tied with aria-describedby; a failed send moves focus to
   the first answer that needs another look and says how many; the
   thank-you heading takes focus. The honeypot is off-screen, out of the
   tab order and hidden from assistive tech. Motion is one fade, off when
   reduced motion is asked for.
   ============================================================ */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { IconName, Priority, PublicFormFailure, PublicFormLoad, PublicFormSchema, PublicFormSubmission } from "../data/types";
import { Button } from "../components/primitives/kit";
import { Icon } from "../components/primitives/Icon";
import { KanboLogo } from "../components/primitives/KanboLogo";
import { ProjectCover } from "../components/primitives/ProjectTile";
import { copyText } from "../components/rituals/shared";
import { FULL_HEIGHT } from "../lib/viewport";
import {
  applyPublicTheme, DEMO_PUBLIC_TOKEN, FAILURE_MESSAGES, loadPublicForm, localISODate, PUBLIC_LIMITS,
  submitPublicForm, validateSubmission,
} from "../lib/publicForms";
import "./publicForm.css";

export interface PublicFormPageProps {
  token: string;
}

type Values = Required<Pick<PublicFormSubmission, "title" | "name" | "email">> & {
  description: string;
  priority: Priority;
  dueDate: string;
  website: string;
};
type FieldKey = keyof PublicFormSubmission;
type Errors = Partial<Record<FieldKey, string>>;
type Failure = Extract<PublicFormLoad, { ok: false }>;

const EMPTY: Values = { title: "", description: "", priority: "medium", dueDate: "", name: "", email: "", website: "" };
const FIELD_ORDER: FieldKey[] = ["title", "description", "priority", "dueDate", "name", "email"];
const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" },
];
/** Show a character count once this much of the limit is used. */
const COUNT_FROM = 0.8;

const draftKey = (token: string) => `kanbo-public-form:${token}`;
function readDraft(token: string): Partial<Values> | null {
  try {
    const raw = window.sessionStorage.getItem(draftKey(token));
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Values> = {};
    for (const k of ["title", "description", "dueDate", "name", "email"] as const) if (typeof v[k] === "string") out[k] = (v[k] as string).slice(0, 6000);
    if (typeof v.priority === "string" && PRIORITIES.some((p) => p.value === v.priority)) out.priority = v.priority as Priority;
    return out;
  } catch { return null; }
}
function writeDraft(token: string, v: Values | null) {
  try {
    if (!v) { window.sessionStorage.removeItem(draftKey(token)); return; }
    const { website: _bot, ...keep } = v;
    void _bot;
    window.sessionStorage.setItem(draftKey(token), JSON.stringify(keep));
  } catch { /* private mode, storage full: the draft just isn't kept */ }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtCount = (n: number) => n.toLocaleString("en-GB");
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const minutes = (s?: number) => Math.max(1, Math.round((s ?? 60) / 60));

/* ============================== the page ============================== */

export function PublicFormPage({ token }: PublicFormPageProps) {
  const demo = token === DEMO_PUBLIC_TOKEN;
  const [load, setLoad] = useState<PublicFormLoad | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  // the form was switched off (or deleted) while someone was filling it in
  const [replaced, setReplaced] = useState(false);

  // Paper unless the visitor's system is dark; never the app's saved theme
  useLayoutEffect(() => applyPublicTheme(), []);

  // a private link: keep it out of search engines
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let alive = true;
    loadPublicForm(token).then((r) => { if (alive) { setLoad(r); setRetrying(false); } });
    return () => { alive = false; };
  }, [token, attempt]);

  const retry = useCallback(() => { setRetrying(true); setAttempt((a) => a + 1); }, []);

  // offline when it opened: try again as soon as the connection is back
  const failedReason = load && !load.ok ? load.reason : null;
  useEffect(() => {
    if (failedReason !== "network") return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failedReason, retry]);

  const form = load?.ok ? load.form : null;
  useEffect(() => {
    const before = document.title;
    document.title = form
      ? `${form.name} · ${form.workspace?.name || form.project.name}`
      : load && !load.ok ? `${PROBLEM_COPY[load.reason].title} · Kanbo` : "Request form · Kanbo";
    return () => { document.title = before; };
  }, [form, load]);

  return (
    <div className="kpub" style={{ height: FULL_HEIGHT }} data-state={load === null ? "loading" : load.ok ? "form" : load.reason}>
      <main className="kpub-main" aria-busy={load === null || undefined}>
        {demo && (
          <p className="kpub-preview">
            <Icon name="eye" size={14} sw={1.75} />
            <span><strong>Preview.</strong> This is how a public request form looks. Nothing you send here is saved.</span>
          </p>
        )}
        {load === null ? (
          <Loading />
        ) : load.ok ? (
          <RequestForm key={token} token={token} form={load.form} demo={demo} onGone={(f) => { setReplaced(true); setLoad(f); }} />
        ) : (
          <Problem failure={load} onRetry={retry} retrying={retrying} takeFocus={replaced} />
        )}
      </main>
      <Footer />
    </div>
  );
}

export default PublicFormPage;

/* ============================== loading ============================== */

function Loading() {
  return (
    <div className="kpub-card" data-loading="true">
      <div className="kpub-cover-skel kskel" aria-hidden="true" />
      <div className="kpub-head">
        <span className="kpub-tile-skel kskel" aria-hidden="true" />
        <span className="kskel kpub-line" style={{ width: "34%" }} aria-hidden="true" />
        <span className="kskel kpub-line kpub-line-lg" style={{ width: "62%" }} aria-hidden="true" />
        <span className="kskel kpub-line" style={{ width: "88%" }} aria-hidden="true" />
      </div>
      <p className="sr-only" role="status">Loading the form…</p>
    </div>
  );
}

/* ============================== problems ============================== */

const PROBLEM_COPY: Record<PublicFormFailure, { title: string; body: string; icon: IconName; retry: boolean }> = {
  not_found: { title: "We couldn't find this form", body: "The link may be mistyped or out of date. Check it with whoever sent it to you.", icon: "search", retry: false },
  disabled: { title: "This form isn't taking requests", body: "The team has switched this link off for now. If you still need something, get in touch with them another way.", icon: "lock", retry: false },
  rate_limited: { title: "Too many requests from here", body: "", icon: "clock", retry: true },
  invalid: { title: "This form couldn't be opened", body: FAILURE_MESSAGES.unavailable, icon: "alert", retry: true },
  unavailable: { title: "This form isn't available right now", body: "Something went wrong on our side. Try again in a few minutes.", icon: "alert", retry: true },
  network: { title: "Kanbo couldn't be reached", body: "Check your connection, then try again. It'll try again by itself when you're back online.", icon: "refresh", retry: true },
};

function Problem({ failure, onRetry, retrying, takeFocus }: { failure: Failure; onRetry: () => void; retrying: boolean; takeFocus?: boolean }) {
  const copy = PROBLEM_COPY[failure.reason];
  const offline = failure.reason === "network" && typeof navigator !== "undefined" && navigator.onLine === false;
  const title = offline ? "You're offline" : copy.title;
  const body = failure.reason === "rate_limited"
    ? `Wait about ${plural(minutes(failure.retryAfter), "minute")}, then try again.`
    : copy.body;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // a state that replaces the form (it was switched off mid-way) is announced by moving focus to it
  useEffect(() => { if (takeFocus) headingRef.current?.focus(); }, [takeFocus]);
  return (
    <section className="kpub-card kpub-problem" aria-labelledby="kpub-problem-title" data-reason={failure.reason}>
      <span className="kpub-problem-mark" data-tone={failure.reason === "not_found" || failure.reason === "disabled" ? "quiet" : "signal"} aria-hidden="true">
        <Icon name={copy.icon} size={20} sw={1.75} />
      </span>
      <h1 id="kpub-problem-title" className="kpub-problem-title" tabIndex={-1} ref={headingRef}>{title}</h1>
      <p className="kpub-problem-body">{body}</p>
      {copy.retry && (
        <div className="kpub-problem-act">
          <Button variant="secondary" size="lg" icon="refresh" loading={retrying} onClick={onRetry}>Try again</Button>
        </div>
      )}
    </section>
  );
}

/* ============================== the form ============================== */

function RequestForm({ token, form, demo, onGone }: { token: string; form: PublicFormSchema; demo: boolean; onGone: (f: Failure) => void }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (k: string) => `kpub-${uid}-${k}`;
  const asks = (k: "description" | "priority" | "dueDate") => form.fields.includes(k);
  const [values, setValues] = useState<Values>(() => ({ ...EMPTY, ...(readDraft(token) ?? {}) }));
  const [errors, setErrors] = useState<Errors>({});
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [reference, setReference] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [copied, setCopied] = useState(false);
  const refs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  const doneRef = useRef<HTMLHeadingElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const today = useMemo(() => localISODate(), []);

  // focus moves happen after React has committed what they point at
  const [focusReq, setFocusReq] = useState<{ to: FieldKey | "banner"; n: number } | null>(null);
  const focusOn = (to: FieldKey | "banner") => setFocusReq((p) => ({ to, n: (p?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focusReq) return;
    (focusReq.to === "banner" ? bannerRef.current : refs.current[focusReq.to])?.focus();
  }, [focusReq]);

  // keep what they've typed for this tab, so a reload or a lost connection doesn't lose it
  useEffect(() => {
    if (phase === "sent") return;
    const t = window.setTimeout(() => writeDraft(token, values), 250);
    return () => window.clearTimeout(t);
  }, [token, values, phase]);

  useEffect(() => { if (phase === "sent") doneRef.current?.focus(); }, [phase]);

  const set = <K extends keyof Values>(k: K, v: Values[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    // an answer being fixed loses its error straight away; a new one waits for Send
    if (errors[k as FieldKey]) setErrors((e) => { const n = { ...e }; delete n[k as FieldKey]; return n; });
  };

  const focusFirst = (errs: Errors) => {
    const first = FIELD_ORDER.find((k) => errs[k]);
    if (first) focusOn(first);
  };

  const submission = (): PublicFormSubmission => ({
    title: values.title, name: values.name, email: values.email,
    ...(asks("description") ? { description: values.description } : {}),
    ...(asks("priority") ? { priority: values.priority } : {}),
    ...(asks("dueDate") && values.dueDate ? { dueDate: values.dueDate } : {}),
    ...(values.website ? { website: values.website } : {}),
  });

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (phase === "sending") return;
    setBanner(null);
    const s = submission();
    const errs = validateSubmission(form, s);
    const n = Object.keys(errs).length;
    if (n) {
      setErrors(errs);
      setSaid(`${plural(n, "answer")} ${n === 1 ? "needs" : "need"} another look.`);
      focusFirst(errs);
      return;
    }
    setErrors({});
    setPhase("sending");
    setSaid("Sending your request…");
    const r = await submitPublicForm(token, s);
    if (!alive.current) return;
    if (r.ok) {
      writeDraft(token, null);
      setReference(r.reference);
      setPhase("sent");
      setSaid("");
      return;
    }
    setPhase("idle");
    if (r.reason === "disabled" || r.reason === "not_found") { onGone({ ok: false, reason: r.reason, message: r.message }); return; }
    if (r.reason === "invalid" && (r.fields || r.field)) {
      const errs2: Errors = r.fields && Object.keys(r.fields).length ? r.fields : { [r.field as FieldKey]: r.message };
      const known = Object.fromEntries(Object.entries(errs2).filter(([k]) => FIELD_ORDER.includes(k as FieldKey))) as Errors;
      if (Object.keys(known).length) {
        setErrors(known);
        setSaid(`${plural(Object.keys(known).length, "answer")} ${Object.keys(known).length === 1 ? "needs" : "need"} another look.`);
        focusFirst(known);
        return;
      }
    }
    const message = r.reason === "rate_limited"
      ? `There have been a lot of requests from here. Wait about ${plural(minutes(r.retryAfter), "minute")}, then send it again. Your answers are still here.`
      : r.reason === "network"
        ? "Your request wasn't sent: Kanbo couldn't be reached. Check your connection, then send it again. Your answers are still here."
        : `Your request wasn't sent. ${r.reason === "invalid" ? r.message : "Try again in a few minutes."} Your answers are still here.`;
    setBanner(message);
    setSaid("");
    focusOn("banner");
  };

  const another = () => {
    setValues((v) => ({ ...EMPTY, name: v.name, email: v.email }));
    setErrors({});
    setReference("");
    setCopied(false);
    setPhase("idle");
    focusOn("title");
  };

  const copyRef = async () => {
    const ok = await copyText(reference);
    if (!alive.current) return;
    setCopied(ok);
    setSaid(ok ? "Reference copied" : "Couldn't copy. Select the reference and copy it yourself.");
    if (ok) window.setTimeout(() => { if (alive.current) setCopied(false); }, 2000);
  };

  const team = form.workspace?.name || null;
  const project = { id: `public:${form.project.name}`, name: form.project.name, emoji: form.project.emoji, color: form.project.color };
  const sending = phase === "sending";

  /** the ids a control is described by: its hint, then its error */
  const describe = (k: FieldKey, hint?: boolean) => [hint ? id(`${k}-hint`) : "", errors[k] ? id(`${k}-err`) : ""].filter(Boolean).join(" ") || undefined;
  const err = (k: FieldKey) => errors[k] ? (
    <p id={id(`${k}-err`)} className="kpub-err"><Icon name="alert" size={14} sw={2} /><span>{errors[k]}</span></p>
  ) : null;
  const counter = (k: "title" | "description") => {
    const len = values[k].length, max = PUBLIC_LIMITS[k];
    if (len < max * COUNT_FROM) return null;
    return <span className="kpub-count" data-full={len >= max || undefined} aria-live="polite">{fmtCount(len)} / {fmtCount(max)}</span>;
  };

  return (
    <article className="kpub-card" aria-labelledby={phase === "sent" ? id("done") : id("title-h")}>
      <ProjectCover project={project} size="page" tile={64} surface="surface" tileInset={24} className="kpub-cover" />
      <header className="kpub-head">
        <p className="kpub-crumbs">
          {form.workspace?.logoUrl ? <img className="kpub-logo" src={form.workspace.logoUrl} alt="" width={20} height={20} referrerPolicy="no-referrer" /> : null}
          {team && <span className="kpub-team">{team}</span>}
          {team && <span className="kpub-dot" aria-hidden="true">·</span>}
          <span className="kpub-project">{form.project.name}</span>
        </p>
        {phase !== "sent" && (
          <>
            <h1 id={id("title-h")} className="kpub-title">{form.name}</h1>
            {form.intro && <p className="kpub-intro">{form.intro}</p>}
          </>
        )}
      </header>

      {phase === "sent" ? (
        <section className="kpub-done" aria-labelledby={id("done")}>
          <span className="kpub-done-mark" aria-hidden="true"><Icon name="check" size={22} sw={2.25} /></span>
          <h1 id={id("done")} className="kpub-title" tabIndex={-1} ref={doneRef}>Request sent</h1>
          <p className="kpub-done-body">
            {firstName(values.name) ? `Thanks, ${firstName(values.name)}. ` : "Thanks. "}
            {demo
              ? "This was a preview, so nothing was sent anywhere."
              : `It's with ${team ? `the ${team} team` : "the team"} now, filed under ${form.project.name}.`}
          </p>
          <div className="kpub-ref">
            <span className="kpub-ref-label" id={id("ref")}>Your reference</span>
            <code className="kpub-ref-code" aria-labelledby={id("ref")}>{reference}</code>
            <Button variant="ghost" size="sm" icon={copied ? "check" : "copy"} onClick={copyRef} aria-label={`Copy reference ${reference}`}>{copied ? "Copied" : "Copy"}</Button>
          </div>
          <p className="kpub-note">Keep the reference in case you need to follow up.</p>
          <div className="kpub-done-act">
            <Button variant="secondary" size="lg" icon="plus" onClick={another}>Send another request</Button>
          </div>
        </section>
      ) : (
        <form className="kpub-form" noValidate onSubmit={send} aria-describedby={banner ? id("banner") : undefined} aria-busy={sending || undefined}>
          {banner && (
            <div id={id("banner")} className="kpub-banner" role="alert" tabIndex={-1} ref={bannerRef}>
              <Icon name="alert" size={16} sw={1.75} /><span>{banner}</span>
            </div>
          )}

          <fieldset className="kpub-group" disabled={sending}>
            <legend className="kpub-legend">Your request</legend>

            <Field id={id("title")} label="What do you need?" hint="A short title, like “Banner for the autumn sale”." hintId={id("title-hint")} extra={counter("title")}>
              <input id={id("title")} ref={(el) => { refs.current.title = el; }} className="kpub-input" type="text" name="title"
                value={values.title} onChange={(e) => set("title", e.target.value)} maxLength={PUBLIC_LIMITS.title}
                aria-required="true" aria-invalid={!!errors.title || undefined} aria-describedby={describe("title", true)} autoComplete="off" enterKeyHint="next" />
              {err("title")}
            </Field>

            {asks("description") && (
              <Field id={id("description")} label="Details" optional hint="Anything that helps: links, sizes, who it's for." hintId={id("description-hint")} extra={counter("description")}>
                <textarea id={id("description")} ref={(el) => { refs.current.description = el; }} className="kpub-input kpub-textarea" name="description" rows={5}
                  value={values.description} onChange={(e) => set("description", e.target.value)} maxLength={PUBLIC_LIMITS.description}
                  aria-invalid={!!errors.description || undefined} aria-describedby={describe("description", true)} />
                {err("description")}
              </Field>
            )}

            {(asks("priority") || asks("dueDate")) && (
              <div className="kpub-row">
                {asks("priority") && (
                  <fieldset className="kpub-field kpub-prio" aria-describedby={errors.priority ? id("priority-err") : undefined}>
                    <legend className="kpub-label">How urgent is it?</legend>
                    <div className="kpub-seg">
                      {PRIORITIES.map((p, i) => (
                        <label key={p.value} className="kpub-seg-opt" data-checked={values.priority === p.value || undefined}>
                          <input type="radio" name={id("priority")} value={p.value} checked={values.priority === p.value}
                            ref={i === 0 ? (el) => { refs.current.priority = el; } : undefined}
                            onChange={() => set("priority", p.value)} />
                          <PrioMark priority={p.value} />
                          <span>{p.label}</span>
                        </label>
                      ))}
                    </div>
                    {err("priority")}
                  </fieldset>
                )}
                {asks("dueDate") && (
                  <Field id={id("dueDate")} label="Needed by" optional className="kpub-due">
                    <input id={id("dueDate")} ref={(el) => { refs.current.dueDate = el; }} className="kpub-input kpub-date" type="date" name="dueDate"
                      value={values.dueDate} min={today} onChange={(e) => set("dueDate", e.target.value)}
                      aria-invalid={!!errors.dueDate || undefined} aria-describedby={describe("dueDate")} />
                    {err("dueDate")}
                  </Field>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="kpub-group" disabled={sending}>
            <legend className="kpub-legend">About you</legend>
            <div className="kpub-row kpub-row-even">
              <Field id={id("name")} label="Your name">
                <input id={id("name")} ref={(el) => { refs.current.name = el; }} className="kpub-input" type="text" name="name"
                  value={values.name} onChange={(e) => set("name", e.target.value)} maxLength={PUBLIC_LIMITS.name}
                  aria-required="true" aria-invalid={!!errors.name || undefined} aria-describedby={describe("name")} autoComplete="name" enterKeyHint="next" />
                {err("name")}
              </Field>
              <Field id={id("email")} label="Your email" hint="So the team can reply." hintId={id("email-hint")}>
                <input id={id("email")} ref={(el) => { refs.current.email = el; }} className="kpub-input" type="email" name="email" inputMode="email"
                  value={values.email} onChange={(e) => set("email", e.target.value)} maxLength={PUBLIC_LIMITS.email}
                  aria-required="true" aria-invalid={!!errors.email || undefined} aria-describedby={describe("email", true)} autoComplete="email" spellCheck={false} enterKeyHint="send" />
                {err("email")}
              </Field>
            </div>
          </fieldset>

          {/* honeypot: people never see or reach it; form-filling bots do */}
          <div className="kpub-hp" aria-hidden="true">
            <label htmlFor={id("website")}>Website</label>
            <input id={id("website")} type="text" name="website" tabIndex={-1} autoComplete="off"
              value={values.website} onChange={(e) => setValues((s) => ({ ...s, website: e.target.value }))} />
          </div>

          <div className="kpub-submit">
            <Button type="submit" variant="primary" size="lg" icon="send" loading={sending}>{sending ? "Sending…" : "Send request"}</Button>
            <p className="kpub-privacy">
              {team ? `Your name, email and request go to the ${team} team` : "Your name, email and request go to the team"}, so they can reply. <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy<span className="sr-only"> (opens in a new tab)</span></a>
            </p>
          </div>
        </form>
      )}
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
    </article>
  );
}

function Field({ id, label, hint, hintId, optional, extra, className, children }: {
  id: string; label: string; hint?: string; hintId?: string; optional?: boolean; extra?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <div className={className ? `kpub-field ${className}` : "kpub-field"}>
      <div className="kpub-label-row">
        <label className="kpub-label" htmlFor={id}>{label}{optional && <span className="kpub-optional"> (optional)</span>}</label>
        {extra}
      </div>
      {hint && <p id={hintId} className="kpub-hint">{hint}</p>}
      {children}
    </div>
  );
}

/** Low · medium · high as one, two, three bars; urgent as the signal square (the app's PriorityGlyph shapes). */
function PrioMark({ priority }: { priority: Priority }) {
  if (priority === "urgent") {
    return (
      <svg className="kpub-prio-mark" data-priority="urgent" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        <rect width={14} height={14} rx={3.5} fill="currentColor" />
        <rect x={6.15} y={2.9} width={1.7} height={5.5} rx={0.85} fill="var(--kpub-on-signal, #fff)" />
        <circle cx={7} cy={10.5} r={1.05} fill="var(--kpub-on-signal, #fff)" />
      </svg>
    );
  }
  const level = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg className="kpub-prio-mark" data-priority={priority} width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {[{ x: 0.75, h: 4 }, { x: 4.75, h: 7 }, { x: 8.75, h: 10 }].map((b, i) => (
        <rect key={i} x={b.x} y={11 - b.h} width={2.5} height={b.h} rx={0.75} fill="currentColor" opacity={i < level ? 1 : 0.25} />
      ))}
    </svg>
  );
}

/* ============================== footer ============================== */

function Footer() {
  return (
    <footer className="kpub-foot">
      <a className="kpub-brand" href="/" aria-label="Powered by Kanbo, the to-do list that plans your day">
        <span aria-hidden="true" className="kpub-brand-mark"><KanboLogo size={16} /></span>
        <span aria-hidden="true">Powered by <strong>Kanbo</strong></span>
      </a>
      <nav className="kpub-legal" aria-label="Legal">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
    </footer>
  );
}

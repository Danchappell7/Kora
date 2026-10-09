/* ============================================================
   KANBO — /admin › System status.                            [w9-ops]
   A live health check (the `health` edge function: database, auth,
   storage, functions — each with its time), the running build (release
   commit + when it was built), error reporting and the uptime monitor,
   and links to Supabase, Vercel, GitHub Actions (uptime runs) and Sentry.
   Admin console only.

   States: checking (first load) · all working · some failing (503) ·
   not deployed (404) · unreachable (timeout / network) · demo (no
   Supabase: a believable healthy report, labelled). Re-checks every
   minute while the tab is visible, and on "Check again".
   `release` / `builtAt`: leave them out to use this build's own
   (BUILD_INFO); pass null to show none.
   ============================================================ */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Icon, IconButton, Pill } from "../primitives";
import { isSupabaseConfigured } from "../../lib/supabase";
import { BUILD_INFO, shortSha } from "../../lib/buildInfo";
import { monitoringInfo, MONITORING_ENVIRONMENT } from "../../lib/monitoring";
import {
  HEALTH_CHECKS, HEALTH_DEPLOY_COMMAND, HEALTH_REFRESH_MS, HEALTH_SLOW_MS, checkErrorText, commitUrl, demoHealthResult,
  fetchHealth, formatLondon, healthSummary, healthUrl, opsLinks, timeAgo, type HealthResult,
} from "../../lib/systemHealth";
import type { HealthCheck } from "../../../supabase/functions/_shared/health.ts";
import "./systemStatus.css";

export interface SystemStatusProps {
  /** the running build's commit (Vite define from VERCEL_GIT_COMMIT_SHA); null locally */
  release?: string | null;
  /** when that build ran (ISO); null locally */
  builtAt?: string | null;
}

const DEMO_DELAY_MS = 350;
const TICK_MS = 15_000;

export function SystemStatus({ release, builtAt }: SystemStatusProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const demo = !isSupabaseConfigured;
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? null;
  const url = demo ? null : healthUrl(supabaseUrl);
  const rel = release === undefined ? BUILD_INFO.release : release;
  const built = builtAt === undefined ? BUILD_INFO.builtAt : builtAt;
  const mon = monitoringInfo();

  const [result, setResult] = useState<HealthResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const lastChecked = useRef(0);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    let r: HealthResult;
    if (demo) r = await new Promise<HealthResult>((res) => setTimeout(() => res(demoHealthResult()), DEMO_DELAY_MS));
    else if (url) r = await fetchHealth(url);
    else r = { state: "unreachable", reason: "network", httpStatus: null, checkedAt: Date.now() };
    inFlight.current = false;
    lastChecked.current = r.checkedAt;
    if (!alive.current) return;
    setResult(r);
    setChecking(false);
    setNow(Date.now());
  }, [demo, url]);

  useEffect(() => {
    alive.current = true;
    void check();
    // every minute while the tab is visible; a return to the tab re-checks a stale result
    const refresh = setInterval(() => { if (document.visibilityState === "visible") void check(); }, HEALTH_REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      if (Date.now() - lastChecked.current > HEALTH_REFRESH_MS) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearInterval(refresh); clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(HEALTH_DEPLOY_COMMAND); setCopied("ok"); }
    catch { setCopied("failed"); }
    setTimeout(() => { if (alive.current) setCopied(null); }, 2500);
  };

  const summary = healthSummary(result);
  const report = result && (result.state === "ok" || result.state === "degraded") ? result.report : null;
  const links = opsLinks({ supabaseUrl, build: BUILD_INFO, sentryIssuesUrl: mon.issuesUrl });
  const commit = commitUrl(rel, BUILD_INFO.repo);
  const env = BUILD_INFO.vercelEnv ?? MONITORING_ENVIRONMENT;
  const builtLondon = formatLondon(built);
  const uptimeHref = links.find((l) => l.id === "uptime")!.href;

  const deployBox = (
    <div className="ksys-cmd">
      <code className="ksys-cmd-text" tabIndex={0} aria-label="Deploy command">{HEALTH_DEPLOY_COMMAND}</code>
      <IconButton icon={copied === "ok" ? "check" : "copy"} label="Copy the deploy command" size="sm" onClick={copyCommand} />
      <span role="status" className="sr-only">{copied === "ok" ? "Copied" : copied === "failed" ? "Couldn’t copy — select the command instead" : ""}</span>
    </div>
  );

  return (
    <section className="ksys" aria-labelledby={`${uid}-t`} aria-busy={checking || undefined}>
      <div className="ksys-head">
        <span className="ksys-head-icon" aria-hidden="true"><Icon name="pulse" size={16} /></span>
        <h2 id={`${uid}-t`} className="ksys-title">System status</h2>
        <span role="status" className="ksys-summary">
          <Pill tone={summary.tone} icon={summary.tone === "ok" ? "check" : summary.tone === "neutral" ? undefined : "alert"}>{summary.text}</Pill>
        </span>
        <span className="ksys-checked">
          {result ? <>Checked <time dateTime={new Date(result.checkedAt).toISOString()}>{timeAgo(result.checkedAt, now)}</time></> : null}
        </span>
        <Button size="sm" icon="refresh" loading={checking} onClick={() => void check()} disabled={checking && !result}>Check again</Button>
      </div>

      {demo && (
        <p className="ksys-note"><Icon name="sparkles" size={14} /> Demo data. On the live site this checks the database, sign-in, storage and edge functions.</p>
      )}

      {result?.state === "missing" && (
        <div className="ksys-banner" data-tone="warn">
          <span className="ksys-banner-icon" aria-hidden="true"><Icon name="alert" size={16} /></span>
          <div className="ksys-banner-main">
            <p className="ksys-banner-title">The health check isn’t deployed yet</p>
            <p className="ksys-banner-text">Deploy it once and this panel and the uptime monitor start working. Run this in Terminal from the project folder:</p>
            {deployBox}
          </div>
        </div>
      )}

      {result?.state === "unreachable" && (
        <div className="ksys-banner" data-tone="signal">
          <span className="ksys-banner-icon" aria-hidden="true"><Icon name="alert" size={16} /></span>
          <div className="ksys-banner-main">
            <p className="ksys-banner-title">{result.reason === "timeout" ? "The health check didn’t answer within 10 seconds" : "Couldn’t reach the health check"}</p>
            <p className="ksys-banner-text">
              {result.reason === "http" ? `It answered HTTP ${result.httpStatus}, which isn’t a health report. ` : "Your connection, Supabase or the function may be down. "}
              Check the edge function logs below, then try again.
            </p>
            <details className="ksys-more">
              <summary><Icon name="chevronRight" size={14} /> Not deployed yet?</summary>
              {deployBox}
            </details>
          </div>
        </div>
      )}

      <div className="ksys-body">
        <div className="ksys-col">
          <h3 className="ksys-sub" id={`${uid}-c`}>Health check</h3>
          <ul className="ksys-list" aria-labelledby={`${uid}-c`}>
            {HEALTH_CHECKS.map((c) => (
              <CheckRow key={c.key} label={c.label} detail={c.detail} check={report ? report[c.key] : null}
                pending={!result} />
            ))}
          </ul>
          {report && (
            <p className="ksys-foot">
              {report.schema ? <>Database schema <span className="ksys-code">{report.schema}</span> · </> : null}
              {result && result.state !== "missing" && result.state !== "unreachable" ? <>round trip <span className="tnum">{result.roundTripMs} ms</span></> : null}
            </p>
          )}
        </div>

        <div className="ksys-col">
          <h3 className="ksys-sub" id={`${uid}-b`}>This build</h3>
          <dl className="ksys-list ksys-facts" aria-labelledby={`${uid}-b`}>
            <div className="ksys-fact">
              <dt>Running build</dt>
              <dd>
                {rel
                  ? (commit
                    ? <a className="ksys-code ksys-a" href={commit} target="_blank" rel="noopener noreferrer" title={rel}>{shortSha(rel)}<span className="sr-only"> (opens the commit on GitHub)</span></a>
                    : <span className="ksys-code" title={rel}>{shortSha(rel)}</span>)
                  : <span className="ksys-dim">Local build</span>}
                <span className="ksys-dim"> · {env}{BUILD_INFO.branch && BUILD_INFO.branch !== "main" ? ` · ${BUILD_INFO.branch}` : ""}</span>
              </dd>
            </div>
            <div className="ksys-fact">
              <dt>Built</dt>
              <dd>{built && builtLondon ? <><time dateTime={built}>{timeAgo(built, now)}</time><span className="ksys-dim"> · {builtLondon}</span></> : <span className="ksys-dim">—</span>}</dd>
            </div>
            <div className="ksys-fact">
              <dt>Error reporting</dt>
              <dd>
                {mon.enabled
                  ? <>On<span className="ksys-dim"> · Sentry · {Math.round(mon.tracesRate * 100)}% of route loads timed</span></>
                  : <>Off<span className="ksys-dim"> · add <span className="ksys-code">VITE_SENTRY_DSN</span> in Vercel</span></>}
              </dd>
            </div>
            <div className="ksys-fact">
              <dt>Uptime monitor</dt>
              <dd>
                Every 10 minutes<span className="ksys-dim"> · GitHub Actions · </span>
                <a className="ksys-a" href={uptimeHref} target="_blank" rel="noopener noreferrer">See runs<span className="sr-only"> (opens GitHub)</span></a>
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <nav className="ksys-links" aria-label="Operations links">
        {links.map((l) => (
          <a key={l.id} className="ksys-link" href={l.href} target="_blank" rel="noopener noreferrer">
            <span className="ksys-link-label">{l.label}</span>
            <span className="ksys-link-detail">{l.detail}</span>
            <Icon name="arrowUpRight" size={14} />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ))}
      </nav>
    </section>
  );
}

function CheckRow({ label, detail, check, pending }: { label: string; detail: string; check: HealthCheck | null; pending: boolean }) {
  const state = !check ? "none" : check.ok ? "ok" : "fail";
  const slow = !!check?.ok && check.ms != null && check.ms >= HEALTH_SLOW_MS;
  return (
    <li className="ksys-check" data-state={state}>
      <span className="ksys-mark" aria-hidden="true">
        {state !== "none" && <Icon name={state === "ok" ? "check" : "x"} size={12} sw={2.5} />}
      </span>
      <span className="ksys-check-text">
        <span className="ksys-check-label">
          {label}
          <span className="sr-only">: {state === "ok" ? (slow ? "working, slowly" : "working") : state === "fail" ? "failing" : pending ? "checking" : "not checked"}</span>
        </span>
        <span className="ksys-check-detail">{state === "fail" ? checkErrorText(check!.error) : slow ? "Working, but slow" : detail}</span>
      </span>
      {pending
        ? <span className="kskel ksys-skel" aria-hidden="true" />
        : <span className="ksys-ms" data-slow={slow || undefined}>{check?.ms != null ? `${check.ms} ms` : "—"}</span>}
    </li>
  );
}

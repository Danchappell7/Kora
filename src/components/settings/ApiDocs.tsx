/* ============================================================
   KANBO — the API reference, rendered from the OpenAPI document.
                                                      [0046 · a1]
   Endpoint list grouped by tag, parameters, request / response examples,
   a copyable curl per endpoint with `baseUrl` filled in, errors, rate
   limits, pagination, idempotency, and a pointer to webhooks. Reads
   buildOpenApi(baseUrl) from supabase/functions/_shared/api/openapi.ts
   (no fetch, no new dependencies). No live "Try it" (keys never belong
   in a browser); demo mode shows the same reference.
   ============================================================ */
import { useId, useMemo, useState, type ReactNode } from "react";
import { Button, Icon, Pill } from "../primitives";
import { copyText } from "../rituals/shared";
import { buildOpenApi, type OpenApiDoc, type OpenApiOperation } from "../../../supabase/functions/_shared/api/openapi.ts";
import { API_RATE } from "../../lib/apiKeys";
import "./developers.css";

export interface ApiDocsProps {
  /** e.g. https://<ref>.supabase.co/functions/v1/api/v1 — lib/apiKeys apiBaseUrl() */
  baseUrl: string;
  /** a key prefix for the examples ("kanbo_sk_Ab3x…"); never a full key */
  keyHint?: string;
  /** shown as a Back / Close control when the reference opens on its own */
  onClose?: () => void;
}

const METHODS = ["get", "post", "patch", "delete"] as const;
type MethodName = (typeof METHODS)[number];
const METHOD_TONE: Record<MethodName, "ok" | "accent" | "warn" | "signal"> = { get: "ok", post: "accent", patch: "warn", delete: "signal" };

export interface DocOp {
  path: string;
  method: MethodName;
  op: OpenApiOperation;
}
export interface DocGroup { tag: string; description?: string; ops: DocOp[] }

/** The document's operations grouped by tag (tags in the document's order), optionally filtered. */
export function groupOperations(doc: OpenApiDoc, filter = ""): DocGroup[] {
  const q = filter.trim().toLowerCase();
  const order = (doc.tags ?? []).map((t) => t.name);
  const groups = new Map<string, DocGroup>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op || typeof op !== "object") continue;
      const hay = `${method} ${path} ${op.summary ?? ""} ${op.description ?? ""} ${op.operationId ?? ""}`.toLowerCase();
      if (q && !q.split(/\s+/).every((w) => hay.includes(w))) continue;
      const tag = op.tags?.[0] ?? "Other";
      if (!groups.has(tag)) groups.set(tag, { tag, description: doc.tags?.find((t) => t.name === tag)?.description, ops: [] });
      groups.get(tag)!.ops.push({ path, method, op });
    }
  }
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return [...groups.values()].sort((a, b) => rank(a.tag) - rank(b.tag) || a.tag.localeCompare(b.tag));
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A curl command for an operation: example path parameters, required query parameters, the example body. */
export function curlFor(baseUrl: string, d: DocOp): string {
  const params = d.op.parameters ?? [];
  const path = d.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const p = params.find((x) => x.in === "path" && x.name === name);
    return encodeURIComponent(String(p?.example ?? `<${name}>`));
  });
  const query = params.filter((p) => p.in === "query" && p.required)
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(p.example ?? `<${p.name}>`))}`);
  const url = `${baseUrl.replace(/\/+$/, "")}${path}${query.length ? `?${query.join("&")}` : ""}`;
  const lines = [`curl ${d.method === "get" ? "" : `-X ${d.method.toUpperCase()} `}"${url}"`];
  const isPublic = Array.isArray(d.op.security) && d.op.security.length === 0;
  if (!isPublic) lines.push(`  -H "Authorization: Bearer $KANBO_API_KEY"`);
  const body = d.op.requestBody?.content?.["application/json"]?.example;
  if (body !== undefined) {
    lines.push(`  -H "Content-Type: application/json"`);
    if (params.some((p) => p.in === "header" && p.name === "Idempotency-Key")) lines.push(`  -H "Idempotency-Key: $(uuidgen)"`);
    lines.push(`  -d ${shellQuote(JSON.stringify(body))}`);
  }
  return lines.join(" \\\n");
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const typeOf = (schema: unknown): string => {
  const s = schema as { type?: unknown; format?: string; enum?: unknown[] } | undefined;
  if (!s) return "";
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null").join(" | ") : String(s.type ?? "");
  return s.format ? `${t} (${s.format})` : t;
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "failed">("idle");
  return (
    <Button size="sm" variant="ghost" icon={state === "ok" ? "check" : "copy"} aria-label={state === "ok" ? `${label} copied` : `Copy ${label}`}
      onClick={() => { void copyText(text).then((ok) => { setState(ok ? "ok" : "failed"); setTimeout(() => setState("idle"), 2000); }); }}>
      {state === "ok" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
    </Button>
  );
}

function Code({ children, label, copy }: { children: string; label: string; copy?: boolean }) {
  return (
    <div className="kdoc-code">
      <pre className="kdev-pre" tabIndex={0} aria-label={label}><code>{children}</code></pre>
      {copy && <div className="kdoc-code-acts"><CopyButton text={children} label={label} /></div>}
    </div>
  );
}

function Endpoint({ d, baseUrl }: { d: DocOp; baseUrl: string }) {
  const { op } = d;
  const params = op.parameters ?? [];
  const body = op.requestBody?.content?.["application/json"];
  const statuses = Object.keys(op.responses ?? {}).sort();
  const success = statuses.find((s) => /^2/.test(s));
  const successRes = success ? op.responses[success] : undefined;
  const example = successRes?.content?.["application/json"]?.example;
  const errors = statuses.filter((s) => Number(s) >= 400);
  const write = op["x-kanbo-access"] === "write";
  const isPublic = Array.isArray(op.security) && op.security.length === 0;
  return (
    <details className="kdoc-op" id={`op-${op.operationId}`}>
      <summary>
        <Icon name="chevronRight" size={14} sw={2} />
        <span className="kdoc-method"><Pill tone={METHOD_TONE[d.method]}>{d.method.toUpperCase()}</Pill></span>
        <code className="kdoc-path">{d.path}</code>
        <span className="kdoc-sum">{op.summary}</span>
        {write && <span className="kdoc-access">Read &amp; write key</span>}
        {isPublic && <span className="kdoc-access">No key needed</span>}
      </summary>
      <div className="kdoc-op-body">
        {op.description && <p className="kdoc-desc">{op.description}</p>}
        {params.length > 0 && (
          <div className="kdoc-table-wrap" tabIndex={0} role="region" aria-label={`${op.summary}: parameters`}>
            <table className="kdoc-table">
              <thead><tr><th scope="col">Parameter</th><th scope="col">In</th><th scope="col">Type</th><th scope="col">About</th></tr></thead>
              <tbody>
                {params.map((p) => (
                  <tr key={`${p.in}-${p.name}`}>
                    <th scope="row"><code>{p.name}</code>{p.required && <span className="kdoc-req"> required</span>}</th>
                    <td>{p.in}</td>
                    <td>{typeOf(p.schema)}</td>
                    <td>{p.description ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {body?.example !== undefined && (
          <>
            <h4 className="kdoc-h">Request body</h4>
            <Code label={`${op.summary}: request body`}>{pretty(body.example)}</Code>
          </>
        )}
        {success && (
          <>
            <h4 className="kdoc-h">Response <span className="kdoc-status">{success}</span>{successRes?.description ? ` · ${successRes.description}` : ""}</h4>
            {example !== undefined && <Code label={`${op.summary}: example response`}>{pretty(example)}</Code>}
          </>
        )}
        {errors.length > 0 && (
          <>
            <h4 className="kdoc-h">Errors</h4>
            <ul className="kdoc-errors">
              {errors.map((s) => <li key={s}><span className="kdoc-status">{s}</span> {op.responses[s]?.description}</li>)}
            </ul>
          </>
        )}
        <h4 className="kdoc-h">Example</h4>
        <Code label={`${op.summary}: curl example`} copy>{curlFor(baseUrl, d)}</Code>
      </div>
    </details>
  );
}

function Guide({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kdoc-guide">
      <h3 className="kdoc-guide-title">{title}</h3>
      <div className="kdoc-guide-body">{children}</div>
    </div>
  );
}

export function ApiDocs({ baseUrl, keyHint, onClose }: ApiDocsProps) {
  const ids = "kdoc" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const base = baseUrl.replace(/\/+$/, "");
  const doc = useMemo(() => buildOpenApi(base), [base]);
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => groupOperations(doc, filter), [doc, filter]);
  const count = groups.reduce((n, g) => n + g.ops.length, 0);
  const hint = keyHint && /^kanbo_(sk|pk)_[A-Za-z0-9_-]{0,8}…?$/.test(keyHint) ? keyHint.replace(/…?$/, "…") : "kanbo_sk_…";

  return (
    <section className="kdoc" aria-labelledby={`${ids}-t`}>
      <header className="kdoc-head">
        <div className="kdoc-head-text">
          <h2 id={`${ids}-t`} className="kdoc-title">API reference</h2>
          <p className="kdoc-subtitle">{doc.info.title} {doc.info.version} · OpenAPI 3.1 · JSON over HTTPS</p>
        </div>
        {onClose && <Button variant="ghost" icon="arrowLeft" onClick={onClose}>Back</Button>}
      </header>

      <div className="kdoc-base">
        <span className="kdoc-base-label">Base URL</span>
        <code className="kdoc-base-url">{base}</code>
        <CopyButton text={base} label="base URL" />
      </div>

      <div className="kdoc-guides">
        <Guide title="Authentication">
          <p>Make a key in Settings › Developers and send it as a bearer token. In the examples, <code>$KANBO_API_KEY</code> stands for your key:</p>
          <Code label="Set your key" copy>{`export KANBO_API_KEY="${hint}"\ncurl -H "Authorization: Bearer $KANBO_API_KEY" ${base}/me`}</Code>
          <p><code>kanbo_sk_</code> keys read and write; <code>kanbo_pk_</code> keys only read. Keep keys on servers and in scripts — never in a web page — so there's no live “Try it” here.</p>
        </Guide>
        <Guide title="Permissions">
          <p>Every request runs as the key's owner, with exactly their access: guests can read and comment but not edit, things you can't see answer 404, and a suspended account's keys stop at once. A team key only reaches its own workspace.</p>
        </Guide>
        <Guide title="Pagination">
          <p>Lists come as <code>{`{ object: "list", data, nextCursor, hasMore }`}</code>. Pass <code>nextCursor</code> back as <code>?cursor=</code> with the same filters. <code>limit</code> is 1–100 (default 50). To sync, filter tasks with <code>updated_since</code>: they come oldest change first.</p>
        </Guide>
        <Guide title="Errors">
          <p>Errors look like <code>{`{ error: { code, message, status, requestId } }`}</code>. <code>validation_failed</code> (422) lists each bad field in <code>details.fields</code>. Quote the <code>requestId</code> if you contact support.</p>
        </Guide>
        <Guide title="Rate limits">
          <p>{API_RATE.max} requests a minute per key. Every answer carries <code>X-RateLimit-Remaining</code>; a 429 says how long to wait in <code>Retry-After</code>.</p>
        </Guide>
        <Guide title="Retries and caching">
          <p>Send an <code>Idempotency-Key</code> header on POST requests: retrying with the same key within 24 hours returns the first answer instead of doing it twice. GET answers carry an <code>ETag</code>; send it back as <code>If-None-Match</code> for a 304 when nothing changed.</p>
        </Guide>
        <Guide title="Safe edits and automations">
          <p>Send the <code>ETag</code> you last saw as <code>If-Match</code> when you change a task or project: if someone changed it in Kanbo since, you get a 412 and nothing is overwritten. A project's automations run for API changes too, as in the app.</p>
        </Guide>
        <Guide title="Webhooks">
          <p>To hear about changes as they happen instead of polling, add a webhook in Settings › Developers › Webhooks. Every delivery is signed so you can check it came from Kanbo.</p>
        </Guide>
      </div>

      <div className="kdoc-filter">
        <label className="sr-only" htmlFor={`${ids}-f`}>Filter endpoints</label>
        <Icon name="search" size={14} sw={2} />
        <input id={`${ids}-f`} type="search" className="kset-input kdoc-filter-input" placeholder="Filter endpoints, e.g. tasks or comment"
          value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${ids}-n`} />
        <span id={`${ids}-n`} className="kdoc-count" role="status">{count} endpoint{count === 1 ? "" : "s"}</span>
      </div>

      {groups.length === 0 && <p className="kdoc-empty">No endpoints match “{filter.trim()}”.</p>}
      {groups.map((g) => (
        <section key={g.tag} className="kdoc-group" aria-labelledby={`${ids}-g-${g.tag}`}>
          <h3 id={`${ids}-g-${g.tag}`} className="kdoc-group-title">{g.tag}</h3>
          {g.description && <p className="kdoc-group-desc">{g.description}</p>}
          <div className="kdoc-ops">
            {g.ops.map((d) => <Endpoint key={`${d.method} ${d.path}`} d={d} baseUrl={base} />)}
          </div>
        </section>
      ))}

      <p className="kdoc-foot">
        The machine-readable description is at <code>{base}/openapi.json</code> (no key needed): import it into Postman, Insomnia or a code generator.
      </p>
    </section>
  );
}

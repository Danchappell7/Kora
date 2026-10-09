/* ============================================================
   KANBO — project docs (the Docs tab, /p/:id/docs/:docId).
                                                  [0047 contract → w5]
   Contract (database 0047):
     tables project_docs, project_doc_versions — select only (RLS: the
       project's audience; guests read). Realtime streams project_docs.
       List:  project_docs?project_id=eq.<id>&select=<DOC_LIST_COLUMNS>
              &order=position.asc.nullslast,created_at.asc
       Versions: project_doc_versions?doc_id=eq.<id>&select=id,doc_id,title,saved_by,saved_at
              &order=saved_at.desc (one version's body: select=* &id=eq.<id>)
     rpc save_project_doc(p_doc, p_project, p_title, p_body jsonb (the block array),
                          p_base_updated_at?, p_icon?, p_mentions uuid[]?, p_checkpoint?)
         → { status: 'saved' | 'conflict', doc }
         new doc: p_doc = a fresh uuid, p_base_updated_at null.
         save: p_base_updated_at = the updatedAt you last loaded/saved (milliseconds are
         enough: a JS Date round trip still matches). Someone saved since → 'conflict'
         with THEIR doc; keep mine = save again with base = their updatedAt.
         p_mentions: everyone the doc @mentions now (newly mentioned people get one
         Inbox notice: kind 'doc_mention', meta { doc_id, project_id }).
         A version is cut per 10 minutes of one person's editing; the last 50 are kept.
         p_checkpoint: this save is a version of its own, never folded into your last
         one (a restore, keep mine), so what the doc said just before stays in history.
     rpc set_project_doc_props(p_doc, p_icon?, p_position?, p_archived?) → doc JSON
         (doesn't change updated_at, so an open editor never conflicts over it)
     rpc delete_project_doc(p_doc) → true
     errors: 'not authorized' · 'invalid doc' · 'invalid body' · 'doc too large' ·
             'invalid title' · 'invalid icon' · 'project not found' · 'doc not found' ·
             'not allowed' (you can see it but not edit: guests) · 'too many docs'
   A deleted project takes its docs (and versions) into the recycle bin.

   Package w5: the async functions below (real + demo fakes: three docs on
   the demo launch project, with versions), the words for failures, and
   the pure block model — it lives in lib/docBlocks (thoroughly tested)
   and is re-exported here under the contract's names. Parsers and limits
   above are final.
   ============================================================ */
import type {
  Activity, DocBlock, DocBlockType, DocFailure, DocSaveInput, DocSaveResult, DocSpan, DocTemplateId, ProjectDoc, ProjectDocListItem, ProjectDocVersion,
} from "../data/types";
import { supabase } from "./supabase";
import { getMember, MEMBERS } from "../data/data";
import { bodyBytes, longDate, newBlockId } from "./docBlocks";

/* the pure block model (lib/docBlocks), under the contract's names */
export {
  newBlockId, docTemplate, blocksToMarkdown, markdownToBlocks, mentionsIn, taskLinksIn,
} from "./docBlocks";

export const DOC_LIMITS = {
  title: 200,
  icon: 64,
  /** the body's JSON, in bytes */
  bytes: 1_048_576,
  perProject: 200,
  versions: 50,
  mentions: 100,
} as const;
/** Autosave after this much idle time (and on blur). */
export const DOC_AUTOSAVE_MS = 2000;
/** project_docs columns for the Docs list (no body). */
export const DOC_LIST_COLUMNS = "id,project_id,workspace_id,title,icon,position,created_by,updated_by,created_at,updated_at,archived_at";
export const DOC_BLOCK_TYPES: readonly DocBlockType[] = ["h1", "h2", "h3", "p", "bullet", "numbered", "todo", "quote", "divider", "callout"];
export const DOC_TEMPLATES: readonly { id: DocTemplateId; label: string; icon: string }[] = [
  { id: "blank", label: "Blank doc", icon: "📄" },
  { id: "brief", label: "Project brief", icon: "🧭" },
  { id: "meeting", label: "Meeting notes", icon: "🗒️" },
  { id: "decisions", label: "Decision log", icon: "⚖️" },
  { id: "retro", label: "Retro", icon: "🔁" },
];

const TYPES = new Set<string>(DOC_BLOCK_TYPES);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pick = (r: Record<string, unknown>, snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A stored body → its blocks (malformed blocks dropped; unknown types read as paragraphs). */
export function parseDocBody(raw: unknown): DocBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: DocBlock[] = [];
  for (const x of raw) {
    const b = obj(x);
    const id = b && str(b.id);
    if (!b || !id) continue;
    const type = typeof b.type === "string" && TYPES.has(b.type) ? (b.type as DocBlockType) : "p";
    const block: DocBlock = { id, type };
    if (Array.isArray(b.spans)) {
      block.spans = b.spans.map(obj).filter((s): s is Record<string, unknown> => !!s && typeof s.text === "string").map((s) => ({
        text: s.text as string,
        ...(Array.isArray(s.marks) ? { marks: s.marks.filter((m): m is "b" | "i" | "code" => m === "b" || m === "i" || m === "code") } : {}),
        ...(typeof s.href === "string" && /^(https?:|mailto:)/i.test(s.href) ? { href: s.href } : {}),
        ...(typeof s.mention === "string" ? { mention: s.mention } : {}),
      }));
    }
    if (typeof b.checked === "boolean") block.checked = b.checked;
    if (typeof b.taskId === "string") block.taskId = b.taskId;
    if (typeof b.icon === "string") block.icon = b.icon;
    if (typeof b.indent === "number" && Number.isFinite(b.indent)) block.indent = Math.max(0, Math.min(3, Math.floor(b.indent)));
    out.push(block);
  }
  return out;
}

/** A doc JSON object / row (snake_case; camelCase also read) → ProjectDoc; null if malformed. */
export function parseProjectDoc(raw: unknown): ProjectDoc | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id), projectId = str(pick(r, "project_id", "projectId")), updatedAt = str(pick(r, "updated_at", "updatedAt"));
  if (!id || !projectId || !updatedAt) return null;
  return {
    id, projectId,
    workspaceId: str(pick(r, "workspace_id", "workspaceId")),
    title: typeof r.title === "string" ? r.title : "",
    body: parseDocBody(r.body),
    icon: str(r.icon),
    position: numOrNull(r.position),
    mentions: (Array.isArray(r.mentions) ? r.mentions : []).filter((m): m is string => typeof m === "string"),
    createdBy: str(pick(r, "created_by", "createdBy")),
    createdByName: str(pick(r, "created_by_name", "createdByName")),
    updatedBy: str(pick(r, "updated_by", "updatedBy")),
    updatedByName: str(pick(r, "updated_by_name", "updatedByName")),
    createdAt: str(pick(r, "created_at", "createdAt")) ?? updatedAt,
    updatedAt,
    archivedAt: str(pick(r, "archived_at", "archivedAt")),
    canEdit: pick(r, "can_edit", "canEdit") === true,
  };
}

/** A Docs-list row (DOC_LIST_COLUMNS) → ProjectDocListItem; null if malformed. */
export function parseProjectDocListItem(raw: unknown): ProjectDocListItem | null {
  const d = parseProjectDoc(raw);
  if (!d) return null;
  const { body: _b, mentions: _m, createdByName: _c, updatedByName: _u, canEdit: _e, ...item } = d;
  return item;
}

/** save_project_doc()'s answer → DocSaveResult; null if malformed. */
export function parseDocSaveResult(raw: unknown): DocSaveResult | null {
  const r = obj(raw);
  if (!r || (r.status !== "saved" && r.status !== "conflict")) return null;
  const doc = parseProjectDoc(r.doc);
  return doc ? { status: r.status, doc } : null;
}

/** A project_doc_versions row → ProjectDocVersion (body null when the list didn't select it). */
export function parseDocVersion(raw: unknown): ProjectDocVersion | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id), docId = str(pick(r, "doc_id", "docId")), savedAt = str(pick(r, "saved_at", "savedAt"));
  if (!id || !docId || !savedAt) return null;
  return {
    id, docId,
    title: typeof r.title === "string" ? r.title : "",
    body: r.body === undefined ? null : parseDocBody(r.body),
    savedBy: str(pick(r, "saved_by", "savedBy")),
    savedAt,
  };
}

/** A database / network error → why (the messages the 0047 functions raise). */
export function docFailure(e: unknown): DocFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || code === "42P01" || /could not find the function|does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/doc too large/i.test(msg)) return "too_large";
  if (/too many docs/i.test(msg)) return "too_many";
  if (/invalid (doc|body|title|icon)/i.test(msg)) return "invalid";
  if (/not authorized|not allowed|permission denied/i.test(msg)) return "not_allowed";
  if (/not found/i.test(msg)) return "not_found";
  return "error";
}

/* ------------------------------------------------------------ words */

/** A failure in words people can act on (British English). */
export const DOC_COPY: Readonly<Record<DocFailure, string>> = {
  not_allowed: "You can read this doc but not change it. Guests can't edit docs.",
  not_found: "This doc isn't here any more. It may have been deleted, or its project moved to the recycle bin.",
  too_large: "This doc is too long to save (the limit is 1 MB). Split it into two docs.",
  too_many: `That's ${DOC_LIMITS.perProject} docs, the most a project can hold. Archive or delete one you no longer need first.`,
  invalid: "Something in this doc couldn't be saved. Check the title (200 characters at most) and try again.",
  unavailable: "Docs aren't switched on yet. The workspace owner needs to run the latest database update.",
  network: "You're offline. Check your connection and try again.",
  error: "Something went wrong. Try again.",
};

/** The sentence for any error the calls below throw. */
export function docErrorText(e: unknown): string {
  return DOC_COPY[docFailure(e)];
}

/** "just now" · "5 minutes ago" · "3 hours ago" · "yesterday" · "4 days ago" · "6 Oct" · "6 Oct 2025". */
export function docAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  const day = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now) - day(then)) / 86400000);
  if (days <= 0) return h === 1 ? "an hour ago" : `${h} hours ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(then);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** A file name for "Export as Markdown": "Launch brief.md" (no path or control characters). */
export function docFileName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (title ?? "").replace(/[\u0000-\u001F\u007F/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).replace(/^\.+/, "");
  return `${base || "Untitled doc"}.md`;
}

/** Hand the browser a Markdown file to save. */
export function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  // revoking straight away can cancel the download in Safari and Firefox
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------------------------------------ for the Inbox (integrator) */

/** A doc_mention notice → the doc's address (/p/:projectId/docs/:docId); null when it isn't one or has no meta. */
export function docMentionRoute(a: Pick<Activity, "kind" | "meta">): { view: "project"; projectId: string; tab: "docs"; docId: string } | null {
  if (a.kind !== "doc_mention" || !a.meta?.docId || !a.meta.projectId) return null;
  return { view: "project", projectId: a.meta.projectId, tab: "docs", docId: a.meta.docId };
}

/** Does a doc_mention belong in this workspace's Inbox? (Its project's workspace; null = Personal.) A project
 *  you can't see here (another workspace, or gone) keeps it out. */
export function docMentionInWorkspace(a: Pick<Activity, "kind" | "meta">, projects: readonly { id: string; workspaceId?: string | null }[], workspaceId: string | null): boolean {
  const r = docMentionRoute(a);
  if (!r) return false;
  const p = projects.find((x) => x.id === r.projectId);
  return !!p && (p.workspaceId ?? null) === workspaceId;
}

/** The Inbox line: "Sana Rao mentioned you in “Launch brief”" (activity.detail is who; task_title the doc's title). */
export function docMentionLine(a: Pick<Activity, "detail" | "taskTitle">): string {
  return `${(a.detail ?? "").trim() || "Someone"} mentioned you in “${(a.taskTitle ?? "").trim() || "Untitled"}”`;
}

/* ------------------------------------------------------------ checks before the server */

/** What the server would refuse anyway, checked first (so a too-long title never costs a round trip). */
function checkInput(input: DocSaveInput): void {
  if (!input.id || !input.projectId) throw new Error("invalid doc");
  if ((input.title ?? "").trim().length > DOC_LIMITS.title) throw new Error("invalid title");
  if (input.icon && input.icon.trim().length > DOC_LIMITS.icon) throw new Error("invalid icon");
  if (!Array.isArray(input.body)) throw new Error("invalid body");
  if (bodyBytes(input.body) > DOC_LIMITS.bytes) throw new Error("doc too large");
}

/* ------------------------------------------------------------ Supabase */

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const asError = (error: { message?: string; code?: string } | null | undefined) =>
  Object.assign(new Error(error?.message || "error"), { code: error?.code });

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabase) throw new Error("could not find the function (demo)");
  if (isOffline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw asError(error);
  return data;
}

const parseList = <T>(raw: unknown, parse: (x: unknown) => T | null): T[] =>
  (Array.isArray(raw) ? raw : []).map(parse).filter((x): x is T => x !== null);

/** A project's docs for the Docs tab (no bodies), in their order; archived ones included (archivedAt set). */
export async function listProjectDocs(projectId: string): Promise<ProjectDocListItem[]> {
  if (!supabase) return demo().list(projectId);
  if (isOffline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.from("project_docs").select(DOC_LIST_COLUMNS).eq("project_id", projectId)
    .order("position", { ascending: true, nullsFirst: false }).order("created_at", { ascending: true });
  if (error) throw asError(error);
  return parseList(data, parseProjectDocListItem);
}

/** One doc with its body; null when it's gone (or you can't see it). `canEdit` comes from the server
 *  (can_edit_project); `createdByName` / `updatedByName` are only filled in by saves — name people from
 *  the members you have. */
export async function getProjectDoc(docId: string): Promise<ProjectDoc | null> {
  if (!supabase) return demo().get(docId);
  if (isOffline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.from("project_docs").select("*").eq("id", docId).maybeSingle();
  if (error) throw asError(error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  let canEdit = false;
  try { canEdit = (await rpc("can_edit_project", { p_project: row.project_id })) === true; } catch { canEdit = false; }
  return parseProjectDoc({ ...row, can_edit: canEdit });
}

/** A save; `checkpoint` makes it a version of its own (a restore, keep mine): what the doc said just
 *  before stays in Version history instead of being folded into your last version. */
export type DocSaveRequest = DocSaveInput & { checkpoint?: boolean };

/** Create (new id, null base) or save a doc. 'conflict' brings back the copy someone else saved. */
export async function saveProjectDoc(input: DocSaveRequest): Promise<DocSaveResult> {
  checkInput(input);
  const mentions = input.mentions == null ? null : [...new Set(input.mentions)].slice(0, DOC_LIMITS.mentions);
  if (!supabase) return demo().save({ ...input, mentions });
  const r = parseDocSaveResult(await rpc("save_project_doc", {
    p_doc: input.id, p_project: input.projectId, p_title: (input.title ?? "").trim(), p_body: input.body,
    p_base_updated_at: input.baseUpdatedAt ?? null, p_icon: input.icon ?? null, p_mentions: mentions,
    // (only when it's one: an ordinary save sends exactly the arguments it always has)
    ...(input.checkpoint ? { p_checkpoint: true } : {}),
  }));
  if (!r) throw new Error("error");
  return r;
}

/** Icon ('' clears it), order and archive. Not an edit: updatedAt stays, so an open editor never conflicts over it. */
export async function setProjectDocProps(docId: string, props: { icon?: string | null; position?: number | null; archived?: boolean | null }): Promise<ProjectDoc> {
  if (props.icon && props.icon.trim().length > DOC_LIMITS.icon) throw new Error("invalid icon");
  if (!supabase) return demo().props(docId, props);
  const d = parseProjectDoc(await rpc("set_project_doc_props", {
    p_doc: docId, p_icon: props.icon ?? null, p_position: props.position ?? null, p_archived: props.archived ?? null,
  }));
  if (!d) throw new Error("error");
  return d;
}

/** Delete for good (with its versions). */
export async function deleteProjectDoc(docId: string): Promise<void> {
  if (!supabase) return demo().remove(docId);
  await rpc("delete_project_doc", { p_doc: docId });
}

/** Newest first, without bodies. */
export async function listDocVersions(docId: string): Promise<ProjectDocVersion[]> {
  if (!supabase) return demo().versions(docId);
  if (isOffline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.from("project_doc_versions").select("id,doc_id,title,saved_by,saved_at").eq("doc_id", docId)
    .order("saved_at", { ascending: false }).order("id", { ascending: false }).limit(DOC_LIMITS.versions);
  if (error) throw asError(error);
  return parseList(data, parseDocVersion);
}

/** One version with its body. */
export async function getDocVersion(versionId: string): Promise<ProjectDocVersion | null> {
  if (!supabase) return demo().version(versionId);
  if (isOffline()) throw new TypeError("Failed to fetch");
  const { data, error } = await supabase.from("project_doc_versions").select("*").eq("id", versionId).maybeSingle();
  if (error) throw asError(error);
  return data ? parseDocVersion(data) : null;
}

export type DocChange = {
  type: "INSERT" | "UPDATE" | "DELETE";
  docId: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** the row as a list item when the message carried it (icon, archive, order…); absent for deletes and big rows */
  item?: ProjectDocListItem | null;
};
let channelSeq = 0;

/** Live changes to a project's docs (realtime, RLS-scoped). Treat it as a ping — refetch the doc (a big body may not
 *  fit in a realtime message) and compare updatedAt with the editor's base. Returns unsubscribe. Deletes can't be
 *  filtered by project (Postgres sends only the id), so a DELETE may name a doc from elsewhere: check it's yours.
 *  In demo mode the in-memory docs tell their own subscribers. */
export function subscribeProjectDocs(projectId: string, onChange: (change: DocChange) => void): () => void {
  if (!supabase) return demo().listen(projectId, onChange);
  const client = supabase;
  let off = false;
  const forward = (type: DocChange["type"]) => (p: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
    if (off) return;
    const row = (type === "DELETE" ? p.old : p.new) ?? {};
    const docId = typeof row.id === "string" ? row.id : null;
    if (!docId) return;
    onChange({
      type, docId,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
      item: type === "DELETE" ? null : parseProjectDocListItem(row),
    });
  };
  const filter = `project_id=eq.${projectId}`;
  const ch = client.channel(`project-docs-${projectId}-${++channelSeq}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "project_docs", filter }, forward("INSERT"))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "project_docs", filter }, forward("UPDATE"))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "project_docs" }, forward("DELETE"))
    .subscribe();
  return () => { off = true; void client.removeChannel(ch); };
}

/* ------------------------------------------------------------ demo (no Supabase)
   Three docs on the demo launch project (a brief with @mentions and Make-task
   lines, last week's meeting notes, a decision log), each with a few versions.
   Same rules as the server: optimistic concurrency on updatedAt, a version per
   10 minutes of one person's editing (a checkpoint always starts one; the
   last 50), 200 docs a project. */

type Listener = (c: DocChange) => void;
interface DemoState {
  docs: Map<string, ProjectDoc>;
  versions: Map<string, ProjectDocVersion[]>;
  listeners: Map<string, Set<Listener>>;
}
let demoState: DemoState | null = null;
let demoSeq = 0;

const isTest = (() => { try { return import.meta.env?.MODE === "test"; } catch { return false; } })();
/** a beat, so Saving… shows in the demo as it would for real (none in tests) */
const beat = <T>(v: T): Promise<T> => (isTest ? Promise.resolve(v) : new Promise((r) => window.setTimeout(() => r(v), 160)));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const demoMe = (): string => MEMBERS.find((m) => m.type === "self")?.id ?? "m-self";
const nameOf = (id: string | null): string | null => (id ? getMember(id)?.name ?? null : null);

function demo() {
  const st = (demoState ??= seedDemo());
  const tell = (projectId: string, c: DocChange) => {
    const ls = st.listeners.get(projectId);
    if (ls) queueMicrotask(() => ls.forEach((l) => l(c)));
  };
  const stamp = (prev?: string) => new Date(Math.max(Date.now(), prev ? new Date(prev).getTime() + 1 : 0)).toISOString();
  const named = (d: ProjectDoc): ProjectDoc => ({ ...clone(d), createdByName: nameOf(d.createdBy), updatedByName: nameOf(d.updatedBy), canEdit: true });
  const item = (d: ProjectDoc): ProjectDocListItem => parseProjectDocListItem(d)!;
  const cutVersion = (d: ProjectDoc, me: string, checkpoint = false) => {
    const list = st.versions.get(d.id) ?? [];
    const last = list[0];
    if (!checkpoint && last && last.savedBy === me && Date.now() - new Date(last.savedAt).getTime() < 10 * 60000) {
      list[0] = { ...last, title: d.title, body: clone(d.body) };
    } else {
      list.unshift({ id: `dv-${++demoSeq}-${Date.now().toString(36)}`, docId: d.id, title: d.title, body: clone(d.body), savedBy: me, savedAt: d.updatedAt });
    }
    st.versions.set(d.id, list.slice(0, DOC_LIMITS.versions));
  };
  const find = (id: string) => {
    const d = st.docs.get(id);
    if (!d) throw new Error("doc not found");
    return d;
  };
  return {
    list: (projectId: string) => beat([...st.docs.values()].filter((d) => d.projectId === projectId)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.createdAt.localeCompare(b.createdAt)).map(item)),
    get: (id: string) => beat(st.docs.has(id) ? named(st.docs.get(id)!) : null),
    save: (input: DocSaveRequest): Promise<DocSaveResult> => {
      const me = demoMe();
      const cur = st.docs.get(input.id);
      const title = (input.title ?? "").trim();
      let d: ProjectDoc;
      if (!cur) {
        if (input.baseUpdatedAt) return Promise.reject(new Error("doc not found"));
        const siblings = [...st.docs.values()].filter((x) => x.projectId === input.projectId);
        if (siblings.length >= DOC_LIMITS.perProject) return Promise.reject(new Error("too many docs"));
        const now = stamp();
        d = {
          id: input.id, projectId: input.projectId, workspaceId: input.projectId === "p-personal" ? null : "ws-foundrise",
          title, body: clone(input.body), icon: input.icon?.trim() || null,
          position: Math.max(0, ...siblings.map((x) => x.position ?? 0)) + 1, mentions: [],
          createdBy: me, createdByName: null, updatedBy: me, updatedByName: null, createdAt: now, updatedAt: now, archivedAt: null, canEdit: true,
        };
      } else {
        if (input.projectId && input.projectId !== cur.projectId) return Promise.reject(new Error("invalid doc"));
        if (!input.baseUpdatedAt || new Date(input.baseUpdatedAt).getTime() !== new Date(cur.updatedAt).getTime()) {
          return beat({ status: "conflict" as const, doc: named(cur) });
        }
        d = {
          ...cur, title, body: clone(input.body),
          icon: input.icon == null ? cur.icon : input.icon.trim() || null,
          updatedBy: me, updatedAt: stamp(cur.updatedAt),
        };
      }
      if (input.mentions) d.mentions = [...input.mentions];
      st.docs.set(d.id, d);
      cutVersion(d, me, !!input.checkpoint);
      tell(d.projectId, { type: cur ? "UPDATE" : "INSERT", docId: d.id, updatedAt: d.updatedAt, updatedBy: me, item: item(d) });
      return beat({ status: "saved" as const, doc: named(d) });
    },
    props: (id: string, props: { icon?: string | null; position?: number | null; archived?: boolean | null }) => {
      let d: ProjectDoc;
      try { d = find(id); } catch (e) { return Promise.reject(e); }
      const next: ProjectDoc = {
        ...d,
        icon: props.icon == null ? d.icon : props.icon.trim() || null,
        position: props.position ?? d.position,
        archivedAt: props.archived == null ? d.archivedAt : props.archived ? d.archivedAt ?? new Date().toISOString() : null,
      };
      st.docs.set(id, next);
      tell(next.projectId, { type: "UPDATE", docId: id, updatedAt: next.updatedAt, updatedBy: next.updatedBy, item: item(next) });
      return beat(named(next));
    },
    remove: (id: string) => {
      let d: ProjectDoc;
      try { d = find(id); } catch (e) { return Promise.reject(e); }
      st.docs.delete(id);
      st.versions.delete(id);
      tell(d.projectId, { type: "DELETE", docId: id, updatedAt: null, updatedBy: null, item: null });
      return beat(undefined);
    },
    versions: (id: string) => beat((st.versions.get(id) ?? []).map((v) => ({ ...v, body: null }))),
    version: (vid: string) => {
      for (const list of st.versions.values()) {
        const v = list.find((x) => x.id === vid);
        if (v) return beat(clone(v));
      }
      return beat(null);
    },
    listen: (projectId: string, fn: Listener) => {
      const set = st.listeners.get(projectId) ?? new Set<Listener>();
      set.add(fn);
      st.listeners.set(projectId, set);
      return () => { set.delete(fn); };
    },
  };
}

/** Forget the demo docs (tests). */
export function resetDemoDocs(): void { demoState = null; }

/* the demo's docs, written in the voice of the Foundrise team */
function seedDemo(): DemoState {
  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60000).toISOString();
  const day = (daysAgo: number) => { const d = new Date(now - daysAgo * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const id = () => newBlockId();
  const t = (text: string, marks?: ("b" | "i" | "code")[]): DocSpan => (marks ? { text, marks } : { text });
  const at = (memberId: string): DocSpan => ({ text: "@" + (getMember(memberId)?.name ?? "someone"), mention: memberId });
  const b = (type: DocBlockType, spans: DocSpan[] | string = [], extra: Partial<DocBlock> = {}): DocBlock => ({
    id: id(), type, ...(type === "divider" ? {} : { spans: typeof spans === "string" ? [t(spans)] : spans }), ...extra,
  });
  const me = demoMe();

  const brief: DocBlock[] = [
    b("callout", "One page on why the Q3 launch matters, what done looks like and who's involved. Keep it current.", { icon: "🧭" }),
    b("h2", "Why we're doing this"),
    b("p", [t("New teams tell us onboarding takes too long. The redesign and the new pricing page land together, so we're launching them as "), t("one story", ["b"]), t(" rather than two quiet releases.")]),
    b("h2", "What done looks like"),
    b("bullet", "Trial-to-paid conversion up from 9% to 12% by the end of Q4"),
    b("bullet", "80% of new teams finish onboarding in under ten minutes"),
    b("bullet", [t("Press coverage in at least two trade titles "), t("in launch week", ["i"])]),
    b("h2", "Milestones"),
    b("todo", "Pick the launch date with leadership", { checked: true, taskId: "t-13" }),
    b("todo", "Finalise the narrative deck", { checked: false, taskId: "t-1" }),
    b("todo", "Ship the onboarding redesign to staging", { checked: false, taskId: "t-2" }),
    b("todo", "Launch day", { checked: false }),
    b("h2", "People"),
    b("bullet", [t("Owner: ", ["b"]), at(me)]),
    b("bullet", [t("Design: ", ["b"]), at("m-3")]),
    b("bullet", [t("Engineering: ", ["b"]), at("m-1"), t(" and "), at("m-2")]),
    b("h2", "Risks and open questions"),
    b("bullet", [t("Design tokens v2 are late, and staging waits on them. "), at("m-3"), t(" is on it.")]),
    b("bullet", [t("Do we need a press embargo? See the "), { text: "comms guide", href: "https://foundrise.example/comms-guide" }, t(".")]),
  ];
  const sync: DocBlock[] = [
    b("p", [t("Date: ", ["b"]), t(longDate(day(3)))]),
    b("p", [t("Attendees: ", ["b"]), at(me), t(", "), at("m-1"), t(", "), at("m-3"), t(", "), at("m-2")]),
    b("h2", "Agenda"),
    b("numbered", "Where the deck stands"),
    b("numbered", "What's blocking staging"),
    b("numbered", "Launch-day comms"),
    b("h2", "Notes"),
    b("bullet", [t("The deck is at 18 slides; we agreed to "), t("cut it to 14", ["i"]), t(" before the leadership review.")]),
    b("bullet", "Staging is blocked on design tokens v2."),
    b("bullet", "Sana expects to hand them over by Thursday.", { indent: 1 }),
    b("bullet", [t("Theo wants the analytics events in before launch: "), t("signup_started", ["code"]), t(" and "), t("onboarding_done", ["code"]), t(".")]),
    b("h2", "Decisions"),
    b("bullet", "We launch on a Tuesday, not a Monday, so support is fully staffed."),
    b("h2", "Actions"),
    b("todo", "Prep the launch-day comms plan", { checked: false, taskId: "t-20" }),
    b("todo", "Write the press release", { checked: false, taskId: "t-17" }),
    b("todo", "Book a room for the launch party", { checked: false }),
  ];
  const log: DocBlock[] = [
    b("callout", "One entry per decision, newest at the top: what we decided, why, and who made the call.", { icon: "⚖️" }),
    b("h3", `${longDate(day(1))}: launch on a Tuesday`),
    b("bullet", [t("Decision: ", ["b"]), t("Launch day moves from Monday to Tuesday.")]),
    b("bullet", [t("Why: ", ["b"]), t("Support is fully staffed and the newsletter goes out that morning.")]),
    b("bullet", [t("Decided by: ", ["b"]), at(me)]),
    b("divider"),
    b("h3", `${longDate(day(8))}: the price stays at £12 a seat`),
    b("bullet", [t("Decision: ", ["b"]), t("No price change at launch; we test annual plans in Q4 instead.")]),
    b("bullet", [t("Options we considered: ", ["b"]), t("£10 to win switchers, £15 with the new features.")]),
    b("bullet", [t("Decided by: ", ["b"]), at("m-1"), t(" and "), at(me)]),
    b("divider"),
  ];

  const docs = new Map<string, ProjectDoc>();
  const versions = new Map<string, ProjectDocVersion[]>();
  const add = (d: Omit<ProjectDoc, "createdByName" | "updatedByName" | "canEdit" | "workspaceId" | "archivedAt" | "mentions">, history: [number, string, number][]) => {
    const full: ProjectDoc = { ...d, workspaceId: "ws-foundrise", archivedAt: null, mentions: [], createdByName: null, updatedByName: null, canEdit: true };
    const ids = new Set<string>();
    for (const blk of full.body) for (const s of blk.spans ?? []) if (s.mention) ids.add(s.mention);
    full.mentions = [...ids];
    docs.set(full.id, full);
    // history: [minutes ago, who, how many blocks the doc had then]
    versions.set(full.id, history.map(([min, who, n], i) => ({
      id: `dv-${full.id}-${i}`, docId: full.id, title: full.title, body: clone(full.body.slice(0, n)), savedBy: who, savedAt: i === 0 ? full.updatedAt : ago(min),
    })));
  };
  add({ id: "doc-launch-brief", projectId: "p-launch", title: "Launch brief", icon: "🧭", position: 1, body: brief,
    createdBy: me, updatedBy: "m-3", createdAt: ago(14 * 1440), updatedAt: ago(125) },
  [[125, "m-3", brief.length], [26 * 60, me, brief.length - 2], [5 * 1440, "m-1", 13], [14 * 1440, me, 8]]);
  add({ id: "doc-launch-sync", projectId: "p-launch", title: `Launch sync, ${longDate(day(3)).replace(/ \d{4}$/, "")}`, icon: "🗒️", position: 2, body: sync,
    createdBy: me, updatedBy: me, createdAt: ago(3 * 1440 + 50), updatedAt: ago(3 * 1440) },
  [[3 * 1440, me, sync.length], [3 * 1440 + 40, me, 9]]);
  add({ id: "doc-decision-log", projectId: "p-launch", title: "Decision log", icon: "⚖️", position: 3, body: log,
    createdBy: "m-1", updatedBy: "m-1", createdAt: ago(10 * 1440), updatedAt: ago(1440 + 95) },
  [[1440 + 95, "m-1", log.length], [8 * 1440, "m-1", 6]]);
  return { docs, versions, listeners: new Map() };
}

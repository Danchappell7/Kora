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
                          p_base_updated_at?, p_icon?, p_mentions uuid[]?)
         → { status: 'saved' | 'conflict', doc }
         new doc: p_doc = a fresh uuid, p_base_updated_at null.
         save: p_base_updated_at = the updatedAt you last loaded/saved (milliseconds are
         enough: a JS Date round trip still matches). Someone saved since → 'conflict'
         with THEIR doc; keep mine = save again with base = their updatedAt.
         p_mentions: everyone the doc @mentions now (newly mentioned people get one
         Inbox notice: kind 'doc_mention', meta { doc_id, project_id }).
         A version is cut per 10 minutes of one person's editing; the last 50 are kept.
     rpc set_project_doc_props(p_doc, p_icon?, p_position?, p_archived?) → doc JSON
         (doesn't change updated_at, so an open editor never conflicts over it)
     rpc delete_project_doc(p_doc) → true
     errors: 'not authorized' · 'invalid doc' · 'invalid body' · 'doc too large' ·
             'invalid title' · 'invalid icon' · 'project not found' · 'doc not found' ·
             'not allowed' (you can see it but not edit: guests) · 'too many docs'
   A deleted project takes its docs (and versions) into the recycle bin.

   Package w5 implements the async functions (real + demo fakes: 2–3 demo
   docs), the pure block model (newBlockId … markdownToBlocks, thoroughly
   tested) and the components; parsers and limits are final.
   ============================================================ */
import type {
  DocBlock, DocBlockType, DocFailure, DocSaveInput, DocSaveResult, DocTemplateId, ProjectDoc, ProjectDocListItem, ProjectDocVersion,
} from "../data/types";

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

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package w5)`));
const notBuiltSync = (fn: string): never => { throw new Error(`${fn}: not built yet (package w5)`); };

/* ---------- data (w5: real + demo fakes) ---------- */
export function listProjectDocs(_projectId: string): Promise<ProjectDocListItem[]> { return notBuilt("listProjectDocs"); }
export function getProjectDoc(_docId: string): Promise<ProjectDoc | null> { return notBuilt("getProjectDoc"); }
export function saveProjectDoc(_input: DocSaveInput): Promise<DocSaveResult> { return notBuilt("saveProjectDoc"); }
export function setProjectDocProps(_docId: string, _props: { icon?: string | null; position?: number | null; archived?: boolean | null }): Promise<ProjectDoc> { return notBuilt("setProjectDocProps"); }
export function deleteProjectDoc(_docId: string): Promise<void> { return notBuilt("deleteProjectDoc"); }
/** Newest first, without bodies. */
export function listDocVersions(_docId: string): Promise<ProjectDocVersion[]> { return notBuilt("listDocVersions"); }
/** One version with its body. */
export function getDocVersion(_versionId: string): Promise<ProjectDocVersion | null> { return notBuilt("getDocVersion"); }
/** Live changes to a project's docs (realtime, RLS-scoped). Treat it as a ping — refetch the doc (a big body may not
 *  fit in a realtime message) and compare updatedAt with the editor's base. Returns unsubscribe; a no-op in demo mode. */
export function subscribeProjectDocs(_projectId: string, _onChange: (change: { type: "INSERT" | "UPDATE" | "DELETE"; docId: string; updatedAt: string | null; updatedBy: string | null }) => void): () => void {
  return () => {};
}

/* ---------- the pure block model (w5, thorough tests) ---------- */
/** A block id unique within a doc. */
export function newBlockId(): string { return notBuiltSync("newBlockId"); }
/** A starter doc: its title, icon and blocks (British English copy; dates for `today`, YYYY-MM-DD). */
export function docTemplate(_id: DocTemplateId, _ctx: { projectName: string; today: string }): { title: string; icon: string; body: DocBlock[] } { return notBuiltSync("docTemplate"); }
/** Markdown export ("Export as Markdown"). Mentions as @Name, Make-task lines as - [ ] / - [x]. */
export function blocksToMarkdown(_title: string, _blocks: DocBlock[], _ctx?: { memberName?: (id: string) => string | undefined; taskDone?: (id: string) => boolean | undefined }): string { return notBuiltSync("blocksToMarkdown"); }
/** Paste / import: plain text or Markdown → blocks (#, ##, ###, -, *, 1., [ ], [x], >, ---, **b**, *i*, `code`, [text](url)). */
export function markdownToBlocks(_text: string): DocBlock[] { return notBuiltSync("markdownToBlocks"); }
/** Every member id the doc @mentions (send as DocSaveInput.mentions). */
export function mentionsIn(_blocks: DocBlock[]): string[] { return notBuiltSync("mentionsIn"); }
/** Every task id a "Make task" line links to. */
export function taskLinksIn(_blocks: DocBlock[]): string[] { return notBuiltSync("taskLinksIn"); }

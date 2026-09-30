/* ============================================================
   KANBO — bulk task import. Paste a list (one task per line),
   rows copied from Excel / Google Sheets, or drop a CSV exported
   from Asana, Trello, Jira, Planner or Kanbo (or a Trello board's
   JSON export). Columns are matched
   automatically (see lib/importTasks) and everything is shown in a
   live preview — mapping, warnings and the tasks themselves —
   before anything is created.
   ============================================================ */
import { useState, useRef, useMemo, useEffect, useId, useDeferredValue } from "react";
import type { CSSProperties, DragEvent } from "react";
import { Icon } from "./primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { PRIORITY_META, STATUS_META, TAGS } from "../data/data";
import {
  analyseImport, decodeImportBytes, trelloJsonToCsv, FIELD_LABELS, IMPORT_LIMIT,
  type DateOrder, type ImportAnalysis, type ImportField, type ImportMember, type ImportProject, type ImportRow, type ImportSection,
} from "../lib/importTasks";

export { parseImportText } from "../lib/importTasks";
export type { ImportRow } from "../lib/importTasks";

/** What the parent's onImport handler can do with the richer row fields. */
export interface ImportSupport {
  /** Rows with parentIndex are created as sub-tasks of that row. */
  subtasks?: boolean;
  /** Labels in row.newTags are created as tags. */
  newTags?: boolean;
  /** row.sectionName is created as a section in the row's project. */
  newSections?: boolean;
  /**
   * The handler keeps each row's description, tags, start date, estimate,
   * section, extra people and completion date — not just its title, status,
   * priority, project, assignee and due date. Until it says so, the preview
   * doesn't show those and warns that they'll be left off.
   */
  details?: boolean;
}

const PREVIEW_ROWS = 50;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Trello's JSON carries the board's whole history; only the cards are kept
const MAX_JSON_BYTES = 25 * 1024 * 1024;
const TEXT_EXTS = ["csv", "tsv", "tab", "txt", "text", "md", "markdown", "json", ""];
// columns whose values only land when the handler supports `details`
const DETAIL_FIELDS = new Set<ImportField>(["description", "section", "tags", "start", "estimate"]);
const EMPTY: ImportAnalysis = analyseImport("");

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const sentence = (parts: string[]) => {
  const s = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] || "";
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const quoteList = (names: string[], max = 3) => {
  const shown = names.slice(0, max).map((n) => `“${n}”`);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0] || "";
};
const shortDate = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

const chip: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, fontSize: 11, lineHeight: "17px", padding: "0 7px", borderRadius: 6,
  color: "var(--ink-3)", background: "var(--fill-1, var(--surface-2))", border: "1px solid var(--hairline)", whiteSpace: "nowrap",
};
const checkboxRow: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, color: "var(--ink-2)", cursor: "pointer", lineHeight: 1.45 };
const linkBtn: CSSProperties = { border: "none", background: "none", padding: 0, color: "var(--accent)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 };

export function ImportTasksModal({
  open, onClose, onImport, projects = [], members = [], sections, defaultProjectId, defaultProjectName, supports = {},
}: {
  open: boolean;
  onClose: () => void;
  onImport: (rows: ImportRow[]) => void;
  /** Projects tasks can go into (the active workspace's, not archived). Shows an "Import into" picker. */
  projects?: ImportProject[];
  /** People to match Assignee columns and @mentions against (email optional — falls back to loaded members). */
  members?: ImportMember[];
  /** Sections of those projects, so a Section column lands in the right section. */
  sections?: ImportSection[];
  defaultProjectId?: string;
  defaultProjectName?: string;
  supports?: ImportSupport;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [isCsv, setIsCsv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [forceLines, setForceLines] = useState(false);
  const [smartText, setSmartText] = useState(true);
  const [dateOrder, setDateOrder] = useState<"auto" | DateOrder>("auto");
  const [extras, setExtras] = useState(false);
  const [keepFileProjects, setKeepFileProjects] = useState(false);
  const [target, setTarget] = useState(defaultProjectId ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const uid = useId();
  const titleId = `${uid}-title`, descId = `${uid}-desc`, textId = `${uid}-text`, targetId = `${uid}-target`, orderId = `${uid}-order`, hintId = `${uid}-hint`;

  // where rows without their own project go: the project you're in, or the only one there is
  const defaultTarget = projects.length === 0
    ? defaultProjectId ?? ""
    : defaultProjectId && projects.some((p) => p.id === defaultProjectId) ? defaultProjectId : projects.length === 1 ? projects[0].id : "";
  useEffect(() => { if (open) setTarget(defaultTarget); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, defaultProjectId]);

  // The parent rebuilds these arrays on every render (a teammate's edit arriving,
  // the focus timer ticking): key the analysis on what's in them, not their identity.
  const projectsKey = projects.map((p) => `${p.id}\u0001${p.name}`).join("\u0002");
  const membersKey = members.map((m) => `${m.id}\u0001${m.name}\u0001${m.email ?? ""}`).join("\u0002");
  const sectionsKey = sections ? sections.map((x) => `${x.id}\u0001${x.projectId}\u0001${x.name}`).join("\u0002") : "-";
  /* eslint-disable react-hooks/exhaustive-deps */
  const stableProjects = useMemo(() => projects, [projectsKey]);
  const stableMembers = useMemo(() => members, [membersKey]);
  const stableSections = useMemo(() => sections, [sectionsKey]);
  /* eslint-enable react-hooks/exhaustive-deps */
  // a big paste re-analyses behind the typing rather than on every keystroke
  const deferredText = useDeferredValue(text);
  const analyse = (t: string) => analyseImport(t, {
    projects: stableProjects, members: stableMembers, sections: stableSections, defaultProjectId: target || undefined,
    keepFileProjects, dateOrder: dateOrder === "auto" ? undefined : dateOrder, smartText,
    mode: forceLines ? "lines" : "auto", csv: isCsv, extrasToDescription: extras,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const analysis = useMemo(() => (open ? analyse(deferredText) : EMPTY), [open, deferredText, stableProjects, stableMembers, stableSections, target, keepFileProjects, dateOrder, smartText, forceLines, isCsv, extras]);

  if (!open) return null;

  const rows = analysis.rows;
  const w = analysis.warnings;
  const needsTarget = projects.length > 0 && !target && rows.some((r) => !r.projectId);
  const targetName = projects.find((p) => p.id === target)?.name || (target === defaultProjectId ? defaultProjectName : undefined);
  const projectName = (id?: string) => (id ? projects.find((p) => p.id === id)?.name : undefined);
  const otherDest = [...new Set(rows.map((r) => r.projectId).filter((id): id is string => !!id && id !== target))];
  const subtitle = targetName
    ? `Into ${targetName}${otherDest.length ? ` and ${plural(otherDest.length, "other project")}` : ""}`
    : otherDest.length ? `Into ${plural(otherDest.length, "project")}` : "Paste a list, copy rows from a spreadsheet or upload a CSV";
  const canImport = rows.length > 0 && !needsTarget;
  const showSmartToggle = analysis.mode === "lines" || (analysis.mode === "columns" && !analysis.hasHeader);
  // the Project column only decides where tasks go when the user asks it to
  const mapped = analysis.columns.filter((c) => c.field && c.field !== "ignore" && (c.field !== "project" || keepFileProjects));

  const resetInput = () => {
    setText(""); setFileName(""); setIsCsv(false); setError(null); setForceLines(false); setDateOrder("auto"); setExtras(false); setKeepFileProjects(false);
  };

  const handleFile = (file: File) => {
    setError(null);
    const name = file.name.toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() || "" : "";
    if (["xlsx", "xlsm", "xls", "numbers", "ods"].includes(ext)) {
      setError(`Kanbo can't open ${ext.toUpperCase()} files directly. Save or export the sheet as CSV (UTF-8) and upload that, or select the rows, copy them and paste them into the box above.`);
      return;
    }
    if (["pdf", "doc", "docx", "pages", "rtf", "key", "pptx"].includes(ext)) {
      setError("Kanbo can't read that kind of file. Open it, copy the list and paste it into the box above.");
      return;
    }
    // drag and drop skips the file picker's filter, so check the type here too
    if (!TEXT_EXTS.includes(ext) && !file.type.startsWith("text/")) {
      setError("Kanbo can import CSV, TSV and text files, or a Trello board's JSON export. For anything else, copy the list and paste it into the box above.");
      return;
    }
    const isJson = ext === "json";
    if (file.size > (isJson ? MAX_JSON_BYTES : MAX_FILE_BYTES)) {
      setError(isJson
        ? "That file is over 25 MB. Export the board again (or a smaller board) and try once more."
        : "That file is over 5 MB. Split it into smaller files and import them one after another.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      // a NUL byte in a file without a UTF-16 byte-order mark means it isn't text (an image, a zip…)
      const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
      if (!utf16 && bytes.subarray(0, 8192).includes(0)) {
        setError("That file doesn't contain text Kanbo can read. Upload a CSV, TSV or text file, or copy the list and paste it into the box above.");
        return;
      }
      let decoded = decodeImportBytes(bytes);
      if (isJson) {
        const csv = trelloJsonToCsv(decoded);
        if (csv === null) {
          setError("That JSON file isn't a Trello board export. In Trello, open the board's menu, choose Print, export and share → Export as JSON, and upload that file.");
          return;
        }
        decoded = csv;
      }
      setText(decoded); setFileName(file.name); setIsCsv(ext === "csv" || isJson); setForceLines(false); setDateOrder("auto"); setExtras(false); setKeepFileProjects(false);
    };
    reader.onerror = () => setError("Couldn't read that file. Try again, or copy the rows and paste them into the box above.");
    reader.readAsArrayBuffer(file);
  };

  // a file can be dropped anywhere on the dialog (or around it) — never let the browser open it instead
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragOver(true); } };
  const onDragLeave = (e: DragEvent) => { if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragOver(false); };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const doImport = () => {
    if (!canImport) return;
    // imported straight after typing: make sure the last keystrokes are included
    onImport(deferredText === text ? rows : analyse(text).rows);
    resetInput();
    onClose();
  };

  /* ---------- what the user should know before importing ---------- */
  const warnings: string[] = [];
  const notes: string[] = [];
  if (analysis.truncated) warnings.push(`This has ${plural(analysis.totalRows, "task")}. Kanbo imports up to ${IMPORT_LIMIT.toLocaleString("en-GB")} at a time, so only the first ${IMPORT_LIMIT.toLocaleString("en-GB")} will be imported — import the rest in a second batch.`);
  if (w.unreadableDates.count) {
    const ex = w.unreadableDates.examples;
    warnings.push(`${plural(w.unreadableDates.count, "date")} couldn't be read (${w.unreadableDates.count > ex.length ? "such as " : ""}${quoteList(ex)}) and ${w.unreadableDates.count === 1 ? "has" : "have"} been left blank.`);
  }
  if (w.unknownAssignees.count) {
    const many = w.unknownAssignees.names.length > 1;
    warnings.push(`${plural(w.unknownAssignees.count, "task is", "tasks are")} assigned to ${many ? "people who aren't" : "someone who isn't"} in this workspace (${quoteList(w.unknownAssignees.names)}). ${w.unknownAssignees.count === 1 ? "It'll" : "They'll"} be assigned to you instead.`);
  }
  if (w.unknownCompleted.count) warnings.push(`Kanbo couldn't tell whether ${plural(w.unknownCompleted.count, "task is", "tasks are")} done (${quoteList(w.unknownCompleted.names)}), so ${w.unknownCompleted.count === 1 ? "it stays" : "they stay"} open.`);
  if (w.unknownProjects.count) warnings.push(`${w.unknownProjects.names.length > 1 ? "There are no projects" : "There's no project"} called ${quoteList(w.unknownProjects.names)} here, so ${w.unknownProjects.count === 1 ? "that task goes" : "those tasks go"} into ${targetName ? `“${targetName}”` : "the project you choose below"}.`);
  if (w.unknownStatuses.count) warnings.push(`Kanbo doesn't have ${w.unknownStatuses.names.length > 1 ? "statuses" : "a status"} called ${quoteList(w.unknownStatuses.names)}, so ${w.unknownStatuses.count === 1 ? "that task starts" : "those tasks start"} as To do.`);
  // what the file carries that this import can't keep yet
  const leftOff: string[] = [];
  if (!supports.details) {
    if (rows.some((r) => r.description)) leftOff.push("descriptions");
    if (rows.some((r) => r.tags?.length || r.newTags?.length)) leftOff.push("tags");
    if (rows.some((r) => r.sectionId || r.sectionName)) leftOff.push("sections");
    if (rows.some((r) => r.startDate)) leftOff.push("start dates");
    if (rows.some((r) => r.focusMin)) leftOff.push("time estimates");
    if (rows.some((r) => r.collaborators?.length)) leftOff.push("extra assignees");
    if (rows.some((r) => r.completedAt)) leftOff.push("completion dates");
  }
  if (leftOff.length) warnings.push(`${sentence(leftOff)} from ${fileName ? "this file" : "your text"} will be left off — this import keeps each task's title, status, priority, project, assignee and due date.`);
  if (w.newTags.length && supports.details) {
    if (supports.newTags) notes.push(`New ${w.newTags.length === 1 ? "tag" : "tags"} will be created: ${quoteList(w.newTags, 6)}.`);
    else warnings.push(`${quoteList(w.newTags, 6)} ${w.newTags.length === 1 ? "isn't a tag" : "aren't tags"} in Kanbo yet, so ${w.newTags.length === 1 ? "it'll" : "they'll"} be left off. Create ${w.newTags.length === 1 ? "it" : "them"} in Manage tags first to keep ${w.newTags.length === 1 ? "it" : "them"}.`);
  }
  if (w.missingSections.length && supports.details) {
    if (supports.newSections) notes.push(`New ${w.missingSections.length === 1 ? "section" : "sections"} will be added: ${quoteList(w.missingSections, 6)}.`);
    else warnings.push(`${w.missingSections.length > 1 ? "There are no sections" : "There's no section"} called ${quoteList(w.missingSections, 6)} in the project, so those tasks won't be in a section.`);
  }
  if (w.subtasks) {
    const linked = w.subtasks - w.orphanSubtasks;
    if (!supports.subtasks) warnings.push(`${plural(w.subtasks, "sub-task")} will be imported as ${w.subtasks === 1 ? "an ordinary task rather than nested under its parent" : "ordinary tasks rather than nested under their parents"}.`);
    else {
      if (linked) notes.push(`${plural(linked, "sub-task")} will be nested under ${linked === 1 ? "its parent task" : "their parent tasks"}.`);
      if (w.orphanSubtasks) warnings.push(w.orphanSubtasks === 1
        ? "1 sub-task has a parent that isn't in this import, so it'll be imported as an ordinary task."
        : `${plural(w.orphanSubtasks, "sub-task")} have parents that aren't in this import, so they'll be imported as ordinary tasks.`);
    }
  }
  if (w.skippedNoTitle) notes.push(`${plural(w.skippedNoTitle, "row")} had no task name and ${w.skippedNoTitle === 1 ? "was" : "were"} skipped.`);
  if (w.skippedArchived) notes.push(`${plural(w.skippedArchived, "archived item")} ${w.skippedArchived === 1 ? "was" : "were"} skipped.`);
  if (w.skippedHeadings) notes.push(`${plural(w.skippedHeadings, "heading")} above the list ${w.skippedHeadings === 1 ? "was" : "were"} left out.`);
  if (w.commentsToDescription) notes.push(`${plural(w.commentsToDescription, "comment")} ${w.commentsToDescription === 1 ? "was" : "were"} added to the description of the task above ${w.commentsToDescription === 1 ? "it" : "them"}.`);
  if (w.skippedLeading) notes.push(`${plural(w.skippedLeading, "line")} above the column headings ${w.skippedLeading === 1 ? "was" : "were"} skipped.`);

  const dueCount = rows.filter((r) => r.dueDate).length;
  const doneCount = rows.filter((r) => r.status === "done").length;
  const assignedCount = rows.filter((r) => r.assigneeId).length;
  const memberName = (id?: string) => (id ? members.find((m) => m.id === id)?.name : undefined);
  const sectionLabel = (r: ImportRow) => (r.sectionId ? sections?.find((s) => s.id === r.sectionId)?.name : undefined) ?? r.sectionName;

  return (
    <>
      <div onClick={onClose} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className="kbackdrop" style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 55%, transparent)", backdropFilter: "blur(3px)" }} />
      <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} className="glass anim-scalein"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doImport(); } }}
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
        style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 91, width: 620, maxWidth: "calc(100vw - 32px)", maxHeight: "min(90vh, 860px)", borderRadius: 20, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 22px 12px" }}>
          <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "var(--accent-dim)", color: "var(--accent)", flexShrink: 0 }}><Icon name="layers" size={17} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Import tasks</h2>
            <div className="truncate" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{subtitle}</div>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close import" style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 22px 4px", display: "flex", flexDirection: "column", gap: 12 }}>
          <p id={descId} style={{ margin: 0, fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.55 }}>
            One task per line, or columns copied straight from Excel or Google Sheets. CSV exports from Asana, Trello, Jira, Planner and Kanbo work too, as does a Trello board's JSON export — columns such as <strong>Task name</strong>, <strong>Due date</strong>, <strong>Notes</strong>, <strong>Assignee</strong>, <strong>Status</strong> and <strong>Tags</strong> are matched automatically. In a plain list you can add <span className="mono" style={{ color: "var(--ink-2)" }}>!high</span>, <span className="mono" style={{ color: "var(--ink-2)" }}>#project</span>, <span className="mono" style={{ color: "var(--ink-2)" }}>@person</span> or <span className="mono" style={{ color: "var(--ink-2)" }}>tomorrow</span>.
          </p>

          <div style={{ position: "relative" }}>
            <label htmlFor={textId} className="sr-only">Tasks to import</label>
            <textarea id={textId} value={text} onChange={(e) => { setText(e.target.value); setError(null); if (!e.target.value) { setFileName(""); setIsCsv(false); } }} autoFocus spellCheck={false} wrap="off"
              placeholder={"Draft Q3 deck !high tomorrow\nEmail the supplier\nReview budget #finance\n…"}
              style={{ width: "100%", minHeight: 150, maxHeight: 320, resize: "vertical", padding: "12px 14px", borderRadius: 12, border: `1px solid ${dragOver ? "var(--accent)" : "var(--hairline)"}`, background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.6, boxSizing: "border-box" }} />
            {dragOver && (
              <div aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: 12, border: "2px dashed var(--accent)", background: "color-mix(in oklch, var(--accent) 8%, var(--surface-raised))", display: "grid", placeItems: "center", color: "var(--accent)", fontSize: 13, fontWeight: 600, pointerEvents: "none" }}>
                Drop a .csv, .tsv, .txt or Trello .json file
              </div>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" tabIndex={-1} aria-hidden="true" accept=".csv,.tsv,.txt,.md,.json,text/csv,text/plain,text/tab-separated-values,application/json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); if (fileRef.current) fileRef.current.value = ""; }} />
            <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} style={{ fontSize: 12.5 }}><Icon name="folder" size={14} /> Upload a CSV, text or Trello file</button>
            {fileName && <span className="truncate" style={{ ...chip, maxWidth: 200 }} title={fileName}>{fileName}</span>}
            {text && <button type="button" onClick={resetInput} style={{ ...linkBtn, color: "var(--ink-3)", fontWeight: 500 }}>Clear</button>}
            <span role="status" aria-live="polite" style={{ marginLeft: "auto", fontSize: 12.5, color: rows.length ? "var(--accent)" : "var(--ink-4)", fontWeight: 600 }}>
              {rows.length ? `${plural(rows.length, "task")} ready` : text.trim() ? "No tasks found" : ""}
            </span>
          </div>

          {error && <div role="alert" style={{ fontSize: 12.5, color: "var(--ink-2)", background: "color-mix(in oklch, var(--st-blocked) 10%, transparent)", border: "1px solid color-mix(in oklch, var(--st-blocked) 28%, transparent)", borderRadius: 10, padding: "10px 12px", lineHeight: 1.5 }}>{error}</div>}

          {analysis.mode !== "empty" && (
            <section aria-label="How your text is read" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "11px 12px", borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--fill-1, var(--surface))" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "var(--ink-2)" }}>
                <strong style={{ fontWeight: 600 }}>{analysis.mode === "lines" ? "One task per line" : analysis.hasHeader ? `${plural(analysis.columns.length, "column")} with headings` : `${plural(analysis.columns.length, "column")} without headings`}</strong>
                {analysis.mode === "columns"
                  ? <button type="button" style={linkBtn} onClick={() => setForceLines(true)}>Treat each line as one task instead</button>
                  : forceLines && <button type="button" style={linkBtn} onClick={() => setForceLines(false)}>Detect columns</button>}
              </div>
              {mapped.length > 0 && (
                <ul aria-label="Column mapping" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {mapped.map((c) => {
                    // read from the file, but not kept by this import (see the warning below)
                    const dropped = !supports.details && DETAIL_FIELDS.has(c.field!);
                    return (
                      <li key={c.index} style={{ ...chip, color: dropped ? "var(--ink-4)" : "var(--ink-2)" }} title={dropped ? "Left off in this import" : undefined}>
                        <span className="truncate" style={{ maxWidth: 140 }}>{c.header}</span>
                        <span aria-hidden="true" style={{ color: "var(--ink-4)" }}>→</span>
                        <span className="sr-only">{dropped ? "read as" : "imported as"}</span>
                        <span style={{ fontWeight: 600, textDecoration: dropped ? "line-through" : "none" }}>{FIELD_LABELS[c.field!]}</span>
                        {dropped && <span className="sr-only">, left off in this import</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {analysis.ignoredColumns.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>Not imported: {analysis.ignoredColumns.join(", ")}</div>
                  <label style={checkboxRow}>
                    <input type="checkbox" checked={extras} onChange={(e) => setExtras(e.target.checked)} style={{ marginTop: 2 }} />
                    Add {analysis.ignoredColumns.length === 1 ? "this column" : "these columns"} to each task's description
                  </label>
                </div>
              )}
              {showSmartToggle && (
                <label style={checkboxRow}>
                  <input type="checkbox" checked={smartText} onChange={(e) => setSmartText(e.target.checked)} style={{ marginTop: 2 }} />
                  Pick up !priority, #project, @person, dates and durations like “30m” from the text
                </label>
              )}
              {analysis.projectColumn && w.otherProjects.count > 0 && (
                <label style={checkboxRow}>
                  <input type="checkbox" checked={keepFileProjects} onChange={(e) => setKeepFileProjects(e.target.checked)} style={{ marginTop: 2 }} />
                  <span>Put tasks into the projects named in the “{analysis.projectColumn}” column ({quoteList(w.otherProjects.names)}){targetName ? ` instead of “${targetName}”` : ""}</span>
                </label>
              )}
              {analysis.ambiguousDates && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "var(--ink-2)" }}>
                  <label htmlFor={orderId}>Dates like 03/04/2026 are</label>
                  <select id={orderId} value={dateOrder === "auto" ? analysis.dateOrder : dateOrder} onChange={(e) => setDateOrder(e.target.value as DateOrder)}
                    style={{ height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface-raised)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 12.5 }}>
                    <option value="dmy">day first (3 April — UK)</option>
                    <option value="mdy">month first (4 March — US)</option>
                  </select>
                </div>
              )}
            </section>
          )}

          {projects.length > 0 && rows.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label htmlFor={targetId} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>Import into</label>
              <select id={targetId} value={target} onChange={(e) => setTarget(e.target.value)} aria-describedby={needsTarget ? hintId : undefined}
                style={{ flex: "1 1 220px", minWidth: 0, height: 34, padding: "0 10px", borderRadius: 9, border: `1px solid ${needsTarget ? "var(--accent)" : "var(--hairline)"}`, background: "var(--surface-raised)", color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 13 }}>
                {!target && <option value="" disabled>Choose a project…</option>}
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          {(warnings.length > 0 || notes.length > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {warnings.length > 0 && (
                <ul aria-label="Check before importing" style={{ margin: 0, padding: "10px 12px", listStyle: "none", display: "flex", flexDirection: "column", gap: 6, borderRadius: 10, background: "color-mix(in oklch, var(--st-review) 11%, transparent)", border: "1px solid color-mix(in oklch, var(--st-review) 30%, transparent)" }}>
                  {warnings.map((m, i) => (
                    <li key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
                      <span aria-hidden="true" style={{ color: "var(--st-review)", fontWeight: 700, flexShrink: 0 }}>!</span>{m}
                    </li>
                  ))}
                </ul>
              )}
              {notes.length > 0 && (
                <ul aria-label="Notes" style={{ margin: 0, padding: "0 2px", listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                  {notes.map((m, i) => <li key={i} style={{ fontSize: 12, lineHeight: 1.5, color: "var(--ink-3)" }}>{m}</li>)}
                </ul>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11.5, color: "var(--ink-3)" }}>
                <span>Preview</span>
                {dueCount > 0 && <span>· {plural(dueCount, "due date")}</span>}
                {assignedCount > 0 && <span>· {assignedCount.toLocaleString("en-GB")} assigned</span>}
                {doneCount > 0 && <span>· {doneCount.toLocaleString("en-GB")} already done</span>}
              </div>
              <ol aria-label="Preview of the tasks" style={{ margin: 0, padding: 6, listStyle: "none", maxHeight: 230, overflowY: "auto", border: "1px solid var(--hairline)", borderRadius: 12 }}>
                {rows.slice(0, PREVIEW_ROWS).map((r, i) => {
                  const status = r.status || "todo";
                  const who = memberName(r.assigneeId);
                  // only what will actually be saved is shown
                  const details = !!supports.details;
                  const section = details && (r.sectionId || supports.newSections) ? sectionLabel(r) : undefined;
                  const tagLabels = details ? [...(r.tags || []).map((k) => TAGS[k]?.label ?? k), ...(supports.newTags ? r.newTags || [] : [])] : [];
                  const elsewhere = r.projectId && r.projectId !== target ? projectName(r.projectId) : undefined;
                  const isSub = r.parentIndex !== undefined || !!r.parentTitle;
                  return (
                    <li key={i} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 3, padding: "5px 8px", fontSize: 12.5, minWidth: 0 }}>
                      <span title={STATUS_META[status].label} style={{ width: 8, height: 8, borderRadius: 99, flexShrink: 0, marginLeft: isSub ? 14 : 0, background: status === "todo" ? "transparent" : STATUS_META[status].color, border: status === "todo" ? `1.5px solid ${STATUS_META[status].color}` : "none" }} />
                      <span className="sr-only">{STATUS_META[status].label}{isSub ? `, sub-task of ${r.parentTitle}` : ""}:</span>
                      <span className="truncate" title={r.title} style={{ flex: "1 1 150px", minWidth: 0, color: status === "done" ? "var(--ink-3)" : "var(--ink-2)", textDecoration: status === "done" ? "line-through" : "none" }}>{r.title}</span>
                      {r.priority && r.priority !== "medium" && <span style={{ ...chip, color: PRIORITY_META[r.priority].color }}>{PRIORITY_META[r.priority].label}</span>}
                      {r.dueDate && <span style={chip}>Due {shortDate(r.dueDate)}</span>}
                      {details && r.focusMin ? <span style={chip}>{r.focusMin}m</span> : null}
                      {who && <span className="truncate" style={{ ...chip, maxWidth: 110 }}>{who}</span>}
                      {elsewhere && <span className="truncate" style={{ ...chip, maxWidth: 140, color: "var(--ink-2)" }} title={`Goes into ${elsewhere}`}><span className="sr-only">Goes into </span>{elsewhere}</span>}
                      {section && <span className="truncate" style={{ ...chip, maxWidth: 110 }}>{section}</span>}
                      {tagLabels.length > 0 && <span className="truncate" style={{ ...chip, maxWidth: 120 }} title={tagLabels.join(", ")}>{tagLabels.length === 1 ? tagLabels[0] : `${tagLabels.length} tags`}</span>}
                      {details && r.description && <span title="Has a description" style={{ ...chip, padding: "0 5px" }}><Icon name="message" size={11} /><span className="sr-only">Has a description</span></span>}
                    </li>
                  );
                })}
                {rows.length > PREVIEW_ROWS && <li style={{ padding: "5px 8px", fontSize: 11.5, color: "var(--ink-4)" }}>+ {plural(rows.length - PREVIEW_ROWS, "more task")}</li>}
              </ol>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "12px 22px 18px", borderTop: "1px solid var(--hairline)", flexWrap: "wrap" }}>
          {needsTarget && <span id={hintId} style={{ flex: "1 1 180px", fontSize: 12, color: "var(--ink-3)" }}>Choose a project to import into.</span>}
          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-accent" onClick={doImport} disabled={!canImport} aria-describedby={needsTarget ? hintId : undefined}
            aria-keyshortcuts="Meta+Enter Control+Enter" title={canImport ? "Import (⌘/Ctrl + Enter)" : undefined}
            style={canImport ? undefined : { opacity: 0.5, cursor: "not-allowed", transform: "none", boxShadow: "none" }}>
            {rows.length ? `Import ${plural(rows.length, "task")}` : "Import"}
          </button>
          </div>
        </div>
      </div>
    </>
  );
}

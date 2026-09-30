/* ============================================================
   KANBO — bulk task import. Paste a list (one task per line;
   indented lines become sub-tasks), rows copied from Excel /
   Google Sheets, or drop a CSV exported from Asana, Trello, Jira,
   Planner or Kanbo (or a Trello board's JSON export). Columns are
   matched automatically (see lib/importTasks) and everything is
   shown in a live preview — mapping, warnings and the tasks
   themselves, nested as they'll be created — before anything is
   created. It's the kit's Sheet (a bottom sheet on phones).
   ============================================================ */
import { useState, useRef, useMemo, useEffect, useId, useDeferredValue } from "react";
import type { DragEvent } from "react";
import { Button, Icon, PriorityGlyph, Sheet, StatusGlyph } from "./primitives";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TAGS } from "../data/data";
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
/** how deep row i nests (the length of its parent chain), for the preview's indent */
const depthOf = (rows: ImportRow[], i: number): number => {
  let d = 0;
  for (let p = rows[i].parentIndex, hops = 0; p !== undefined && hops < rows.length; p = rows[p].parentIndex, hops++) d++;
  return d;
};

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
  const textRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLParagraphElement>(null);
  const isPhone = useMediaQuery("(max-width: 859px)");
  const uid = useId();
  const descId = `${uid}-desc`, textId = `${uid}-text`, targetId = `${uid}-target`, orderId = `${uid}-order`, hintId = `${uid}-hint`;

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
  const live = useMemo(() => (open ? analyse(deferredText) : null), [open, deferredText, stableProjects, stableMembers, stableSections, target, keepFileProjects, dateOrder, smartText, forceLines, isCsv, extras]);
  // while the sheet fades out it keeps showing what it showed, rather than collapsing to empty
  const shown = useRef<ImportAnalysis>(EMPTY);
  if (live) shown.current = live;
  const analysis = live ?? shown.current;

  // the lede describes the dialog (the Sheet names it; this adds the how-to)
  useEffect(() => {
    if (!open) return;
    const dialog = descRef.current?.closest('[role="dialog"]');
    dialog?.setAttribute("aria-describedby", descId);
  }, [open, descId]);

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

  const size = isPhone ? "lg" : "md";
  const footer = (
    <div className="kimp-foot">
      {needsTarget && <span id={hintId} className="kimp-hint">Choose a project to import into.</span>}
      <Button variant="ghost" size={size} onClick={onClose}>Cancel</Button>
      <Button variant="primary" size={size} onClick={doImport} disabled={!canImport} aria-describedby={needsTarget ? hintId : undefined}
        aria-keyshortcuts="Meta+Enter Control+Enter" title={canImport ? "Import (⌘/Ctrl + Enter)" : undefined} kbd={isPhone ? undefined : "⌘↵"}>
        {rows.length ? `Import ${plural(rows.length, "task")}` : "Import"}
      </Button>
    </div>
  );

  return (
    // a file can be dropped anywhere on the sheet or the scrim around it (React
    // carries the portal's drag events up to here) — never let the browser open it instead
    <div className="kimp-drop" style={{ display: "contents" }} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <Sheet open={open} onClose={onClose} label="Import tasks" title="Import tasks" width={640} footer={footer} initialFocus={textRef as React.RefObject<HTMLElement>}>
        <style>{IMPORT_CSS}</style>
        <div className="kimp" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doImport(); } }}>
          <p className="kimp-where truncate" title={subtitle}>{subtitle}</p>
          <p id={descId} ref={descRef} className="kimp-lede">
            {isPhone ? (
              // the phone gets the short version, so the paste box stays in view
              <>One task per line (indent a line to make it a sub-task), rows from a spreadsheet, or a CSV from Asana, Trello, Jira or Planner. Add <code>!high</code>, <code>#project</code>, <code>@person</code> or <code>tomorrow</code> to a line.</>
            ) : (
              <>One task per line (indent a line to make it a sub-task), or columns copied straight from Excel or Google Sheets. CSV exports from Asana, Trello, Jira, Planner and Kanbo work too, as does a Trello board's JSON export: columns such as <b>Task name</b>, <b>Due date</b>, <b>Notes</b>, <b>Assignee</b>, <b>Status</b> and <b>Tags</b> are matched automatically. In a plain list you can add <code>!high</code>, <code>#project</code>, <code>@person</code> or <code>tomorrow</code>.</>
            )}
          </p>

          <div className="kimp-paste" data-drag={dragOver || undefined}>
            <label htmlFor={textId} className="sr-only">Tasks to import</label>
            <textarea id={textId} ref={textRef} className="kimp-text" value={text} spellCheck={false} wrap="off"
              onChange={(e) => { setText(e.target.value); setError(null); if (!e.target.value) { setFileName(""); setIsCsv(false); } }}
              placeholder={"Draft Q3 deck !high tomorrow\n  Check the numbers\nEmail the supplier\nReview budget #finance\n…"} />
            {dragOver && (
              <div aria-hidden="true" className="kimp-dropzone">
                <Icon name="folder" size={16} sw={1.75} />Drop a .csv, .tsv, .txt or Trello .json file
              </div>
            )}
          </div>

          <div className="kimp-bar">
            <input ref={fileRef} type="file" tabIndex={-1} aria-hidden="true" accept=".csv,.tsv,.txt,.md,.json,text/csv,text/plain,text/tab-separated-values,application/json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); if (fileRef.current) fileRef.current.value = ""; }} />
            <Button variant="secondary" size="sm" icon="folder" onClick={() => fileRef.current?.click()}>Upload a CSV, text or Trello file</Button>
            {fileName && <span className="kimp-file truncate mono" title={fileName}>{fileName}</span>}
            {text && <Button variant="ghost" size="sm" onClick={resetInput}>Clear</Button>}
            <span role="status" aria-live="polite" className="kimp-ready" data-found={rows.length ? "true" : undefined}>
              {rows.length ? <><Icon name="check" size={14} sw={2} />{plural(rows.length, "task")} ready</> : text.trim() ? "No tasks found" : ""}
            </span>
          </div>

          {error && <div role="alert" className="kimp-error">{error}</div>}

          {analysis.mode !== "empty" && (
            <section aria-label="How your text is read" className="kimp-read">
              <div className="kimp-read-head">
                <strong>{analysis.mode === "lines" ? "One task per line" : analysis.hasHeader ? `${plural(analysis.columns.length, "column")} with headings` : `${plural(analysis.columns.length, "column")} without headings`}</strong>
                {analysis.mode === "columns"
                  ? <button type="button" className="kimp-link" onClick={() => setForceLines(true)}>Treat each line as one task instead</button>
                  : forceLines && <button type="button" className="kimp-link" onClick={() => setForceLines(false)}>Detect columns</button>}
              </div>
              {mapped.length > 0 && (
                <ul aria-label="Column mapping" className="kimp-map">
                  {mapped.map((c) => {
                    // read from the file, but not kept by this import (see the warning below)
                    const dropped = !supports.details && DETAIL_FIELDS.has(c.field!);
                    return (
                      <li key={c.index} data-dropped={dropped || undefined} title={dropped ? "Left off in this import" : undefined}>
                        <span className="kimp-map-from truncate">{c.header}</span>
                        <span aria-hidden="true" className="kimp-map-arrow">→</span>
                        <span className="sr-only">{dropped ? "read as" : "imported as"}</span>
                        <span className="kimp-map-to">{FIELD_LABELS[c.field!]}</span>
                        {dropped && <span className="sr-only">, left off in this import</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {analysis.ignoredColumns.length > 0 && (
                <>
                  <p className="kimp-ignored">Not imported: {analysis.ignoredColumns.join(", ")}</p>
                  <label className="kimp-check">
                    <input type="checkbox" checked={extras} onChange={(e) => setExtras(e.target.checked)} />
                    <span>Add {analysis.ignoredColumns.length === 1 ? "this column" : "these columns"} to each task's description</span>
                  </label>
                </>
              )}
              {showSmartToggle && (
                <label className="kimp-check">
                  <input type="checkbox" checked={smartText} onChange={(e) => setSmartText(e.target.checked)} />
                  <span>Pick up !priority, #project, @person, dates and durations like “30m” from the text</span>
                </label>
              )}
              {analysis.projectColumn && w.otherProjects.count > 0 && (
                <label className="kimp-check">
                  <input type="checkbox" checked={keepFileProjects} onChange={(e) => setKeepFileProjects(e.target.checked)} />
                  <span>Put tasks into the projects named in the “{analysis.projectColumn}” column ({quoteList(w.otherProjects.names)}){targetName ? ` instead of “${targetName}”` : ""}</span>
                </label>
              )}
              {analysis.ambiguousDates && (
                <div className="kimp-order">
                  <label htmlFor={orderId}>Dates like 03/04/2026 are</label>
                  <select id={orderId} className="kimp-select" value={dateOrder === "auto" ? analysis.dateOrder : dateOrder} onChange={(e) => setDateOrder(e.target.value as DateOrder)}>
                    <option value="dmy">day first (3 April — UK)</option>
                    <option value="mdy">month first (4 March — US)</option>
                  </select>
                </div>
              )}
            </section>
          )}

          {projects.length > 0 && rows.length > 0 && (
            <div className="kimp-target">
              <label htmlFor={targetId}>Import into</label>
              <select id={targetId} className="kimp-select" value={target} onChange={(e) => setTarget(e.target.value)}
                aria-describedby={needsTarget ? hintId : undefined} aria-invalid={needsTarget || undefined}>
                {!target && <option value="" disabled>Choose a project…</option>}
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          {warnings.length > 0 && (
            <ul aria-label="Check before importing" className="kimp-warn">
              {warnings.map((m, i) => (
                <li key={i}><span aria-hidden="true" className="kimp-warn-mark">!</span>{m}</li>
              ))}
            </ul>
          )}
          {notes.length > 0 && (
            <ul aria-label="Notes" className="kimp-notes">
              {notes.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          )}

          {rows.length > 0 && (
            <div className="kimp-preview">
              <p className="kimp-preview-head">
                <span>Preview</span>
                {dueCount > 0 && <span>· {plural(dueCount, "due date")}</span>}
                {assignedCount > 0 && <span>· {assignedCount.toLocaleString("en-GB")} assigned</span>}
                {doneCount > 0 && <span>· {doneCount.toLocaleString("en-GB")} already done</span>}
              </p>
              <ol aria-label="Preview of the tasks" className="kimp-rows">
                {rows.slice(0, PREVIEW_ROWS).map((r, i) => {
                  const status = r.status || "todo";
                  const who = memberName(r.assigneeId);
                  // only what will actually be saved is shown
                  const details = !!supports.details;
                  const section = details && (r.sectionId || supports.newSections) ? sectionLabel(r) : undefined;
                  const tagLabels = details ? [...(r.tags || []).map((k) => TAGS[k]?.label ?? k), ...(supports.newTags ? r.newTags || [] : [])] : [];
                  const elsewhere = r.projectId && r.projectId !== target ? projectName(r.projectId) : undefined;
                  // nested as it'll be created: under its parent when the handler keeps sub-tasks
                  const depth = supports.subtasks ? depthOf(rows, i) : 0;
                  const isSub = r.parentIndex !== undefined || !!r.parentTitle;
                  return (
                    <li key={i} className="kimp-row" data-done={status === "done" || undefined} style={depth ? { paddingLeft: 8 + depth * 20 } : undefined}>
                      {depth > 0 && <span aria-hidden="true" className="kimp-elbow" />}
                      <StatusGlyph status={status} size={14} />
                      {isSub && <span className="sr-only">Sub-task of {r.parentTitle}:</span>}
                      <span className="kimp-row-title truncate" title={r.title}>{r.title}</span>
                      <span className="kimp-row-meta">
                        {r.priority && r.priority !== "medium" && <PriorityGlyph priority={r.priority} />}
                        {r.dueDate && <span className="mono">Due {shortDate(r.dueDate)}</span>}
                        {details && r.focusMin ? <span className="mono">{r.focusMin}m</span> : null}
                        {who && <span className="truncate kimp-person">{who}</span>}
                        {elsewhere && <span className="truncate kimp-elsewhere" title={`Goes into ${elsewhere}`}><span className="sr-only">Goes into </span>{elsewhere}</span>}
                        {section && <span className="truncate kimp-section">{section}</span>}
                        {tagLabels.length > 0 && <span className="truncate kimp-tags" title={tagLabels.join(", ")}>{tagLabels.length === 1 ? tagLabels[0] : `${tagLabels.length} tags`}</span>}
                        {details && r.description && <span title="Has a description" className="kimp-desc"><Icon name="message" size={12} sw={1.75} /><span className="sr-only">Has a description</span></span>}
                      </span>
                    </li>
                  );
                })}
                {rows.length > PREVIEW_ROWS && <li className="kimp-more">+ {plural(rows.length - PREVIEW_ROWS, "more task")}</li>}
              </ol>
            </div>
          )}
        </div>
      </Sheet>
    </div>
  );
}

/* Kept beside the component (as the capture sheets are), with fallbacks to
   today's tokens so it reads right before and after the token pass. */
const TICK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.2 8.4l2.5 2.5 5.1-5.4' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
const IMPORT_CSS = `
.kimp { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.kimp-where { margin: -4px 0 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kimp-lede { margin: 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kimp-lede b { font-weight: 600; color: var(--ink-2); }
.kimp-lede code { font: 500 11px/16px var(--font-mono); padding: 1px 4px; border-radius: var(--r-xs, 4px); background: var(--fill-1); color: var(--ink-2); }

.kimp-paste { position: relative; }
.kimp-text {
  display: block; width: 100%; min-height: 152px; max-height: 320px; box-sizing: border-box; resize: vertical;
  padding: 12px 14px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface)); color: var(--ink);
  font: 400 12px/20px var(--font-mono); tab-size: 2; white-space: pre; overflow-wrap: normal;
  transition: border-color var(--d-1, 90ms) var(--ease);
}
.kimp-text:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kimp-text::placeholder { color: var(--ink-4); opacity: 1; }
.kimp-paste[data-drag] .kimp-text { border-color: var(--accent); }
.kimp-dropzone {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; pointer-events: none;
  border-radius: var(--r-md, 8px); border: 2px dashed var(--accent-line, var(--accent));
  background: color-mix(in oklch, var(--accent) 8%, var(--surface-raised));
  font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent));
}

.kimp-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 28px; }
.kimp-file { max-width: 200px; height: 24px; padding: 0 8px; border-radius: var(--r-sm, 6px); background: var(--fill-1);
  font-size: 11px; line-height: 24px; color: var(--ink-2); }
.kimp-ready { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kimp-ready[data-found] { color: var(--accent-text, var(--accent)); }

.kimp-error { padding: 10px 12px; border-radius: var(--r-md, 8px); font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2);
  background: var(--signal-tint, color-mix(in oklch, var(--st-blocked) 10%, transparent));
  box-shadow: inset 3px 0 0 var(--signal, var(--st-blocked)); }

.kimp-read { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; border-radius: var(--r-lg, 12px); background: var(--fill-1); }
.kimp-read-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kimp-read-head strong { font-weight: 600; color: var(--ink); }
.kimp-link { padding: 0; border: 0; background: none; cursor: pointer; font: 600 12px/16px var(--font-ui, var(--font-display));
  color: var(--accent-text, var(--accent)); text-decoration: underline; text-decoration-color: color-mix(in oklch, currentColor 40%, transparent); text-underline-offset: 3px; }
.kimp-link:hover { text-decoration-color: currentColor; }
.kimp-map { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.kimp-map li { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 24px; padding: 0 8px; box-sizing: border-box;
  border-radius: var(--r-sm, 6px); background: var(--surface-raised); box-shadow: 0 0 0 1px var(--hairline);
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); white-space: nowrap; }
.kimp-map-from { max-width: 160px; }
.kimp-map-arrow { color: var(--icon-quiet, var(--ink-4)); }
.kimp-map-to { font-weight: 600; color: var(--ink); }
.kimp-map li[data-dropped] { color: var(--ink-4); }
.kimp-map li[data-dropped] .kimp-map-to { color: var(--ink-4); text-decoration: line-through; }
.kimp-ignored { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kimp-check { display: flex; align-items: flex-start; gap: 8px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); cursor: pointer; }
.kimp-check input {
  -webkit-appearance: none; appearance: none; flex-shrink: 0; width: 16px; height: 16px; margin: 2px 0 0; cursor: pointer;
  border-radius: var(--r-xs, 4px); border: 1.5px solid var(--control-border, var(--hairline-strong)); background: var(--field-bg, var(--surface));
  background-position: center; background-repeat: no-repeat; background-size: 14px 14px;
  transition: background-color var(--d-1, 90ms) var(--ease), border-color var(--d-1, 90ms) var(--ease);
}
.kimp-check input:hover { border-color: var(--ink-3); }
.kimp-check input:checked { border-color: transparent; background-color: var(--accent-fill, var(--accent)); background-image: ${TICK}; }
.kimp-order { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }

.kimp-select {
  min-width: 0; height: var(--h-md, 32px); padding: 0 28px 0 10px; box-sizing: border-box;
  border-radius: var(--r-sm, 6px); border: 1px solid var(--field-border, var(--hairline-strong)); background-color: var(--field-bg, var(--surface));
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); text-overflow: ellipsis;
}
.kimp-select:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kimp-select[aria-invalid="true"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.kimp-target { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.kimp-target label { font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kimp-target .kimp-select { flex: 1 1 220px; }

.kimp-warn { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 12px 14px; list-style: none; border-radius: var(--r-md, 8px);
  background: color-mix(in oklch, var(--warn, var(--st-review)) 9%, transparent); }
.kimp-warn li { display: flex; align-items: flex-start; gap: 10px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kimp-warn-mark { display: inline-grid; place-items: center; flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%;
  background: var(--warn, var(--st-review)); color: var(--surface-raised); font: 700 11px/1 var(--font-ui, var(--font-display)); }
.kimp-notes { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0 2px; list-style: none; }
.kimp-notes li { font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); }

.kimp-preview { display: flex; flex-direction: column; gap: 6px; }
.kimp-preview-head { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kimp-preview-head span + span { font-weight: 500; }
/* one scroll (the sheet's): the preview grows with the list rather than scrolling inside it */
.kimp-rows { margin: 0; padding: 4px; list-style: none; border-radius: var(--r-lg, 12px); box-shadow: inset 0 0 0 1px var(--hairline); }
.kimp-row { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 30px; padding: 0 8px; border-radius: var(--r-sm, 6px);
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kimp-row .kglyph { flex-shrink: 0; }
/* a sub-task hangs off the row above: a small elbow in its indent */
.kimp-elbow { flex-shrink: 0; width: 8px; height: 9px; margin: -9px -2px 0 -12px; box-sizing: border-box;
  border-left: 1.5px solid var(--hairline-strong); border-bottom: 1.5px solid var(--hairline-strong); border-bottom-left-radius: 4px; }
.kimp-row-title { flex: 1 1 140px; min-width: 0; }
.kimp-row[data-done] .kimp-row-title { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); }
.kimp-row-meta { display: inline-flex; align-items: center; gap: 10px; flex-shrink: 1; min-width: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kimp-row-meta .mono { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kimp-person, .kimp-section, .kimp-tags { max-width: 120px; }
.kimp-elsewhere { max-width: 140px; color: var(--ink-2); }
.kimp-desc { display: inline-flex; color: var(--icon-quiet, var(--ink-4)); }
.kimp-more { padding: 6px 8px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

.kimp-foot { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; width: 100%; min-width: 0; }
.kimp-hint { flex: 1 1 180px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

@media (max-width: 859px) {
  .kimp-text { min-height: 128px; font-size: 13px; }
  .kimp-row { min-height: 40px; flex-wrap: wrap; row-gap: 0; padding-top: 4px; padding-bottom: 4px; }
  .kimp-row-meta { flex-basis: 100%; padding-left: 22px; flex-wrap: wrap; row-gap: 2px; }
  .kimp-foot { flex-direction: column-reverse; align-items: stretch; gap: 4px; }
  .kimp-foot .kbtn { width: 100%; height: var(--h-touch, 44px); justify-content: center; }
  .kimp-hint { flex: none; text-align: center; padding-top: 4px; }
}
`;

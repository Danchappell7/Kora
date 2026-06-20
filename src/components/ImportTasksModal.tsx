/* ============================================================
   KANBO — bulk task import. Paste from a spreadsheet/PDF/anywhere
   (one task per line, or TSV/CSV with a Title column) or drop a
   .csv/.tsv/.txt file. Smart-parses #project !priority @assignee
   and dates per row, with a live preview before importing.
   ============================================================ */
import { useState, useRef } from "react";
import { Icon } from "./primitives";
import { parseTaskTokens } from "../data/data";
import type { Task } from "../data/types";

type ImportRow = Partial<Task> & { title: string };

// CSV-aware field split (honours quotes); plain split for tab/semicolon.
function splitDelim(line: string, delim: string): string[] {
  if (delim !== ",") return line.split(delim);
  const out: string[] = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}

export function parseImportText(
  raw: string,
  projects: { id: string; name: string }[] = [],
  members: { id: string; name: string }[] = [],
  defaultProjectId?: string,
): ImportRow[] {
  const clean = raw.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  if (!lines.length) return [];
  const delim = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : lines[0].includes(",") ? "," : null;
  const cells0 = delim ? splitDelim(lines[0], delim) : [lines[0]];
  const lower = cells0.map((c) => c.trim().toLowerCase());
  const hasHeader = lower.includes("title") || lower.includes("name") || lower.includes("task");
  const col = (names: string[]) => lower.findIndex((h) => names.includes(h));
  const ti = hasHeader ? Math.max(0, col(["title", "name", "task"])) : 0;
  const pri = hasHeader ? col(["priority"]) : -1;
  const dui = hasHeader ? col(["due", "due date", "duedate", "deadline"]) : -1;
  const sti = hasHeader ? col(["status"]) : -1;
  const body = hasHeader ? lines.slice(1) : lines;
  const out: ImportRow[] = [];
  for (const line of body) {
    const cells = delim ? splitDelim(line, delim) : [line];
    const titleCell = (cells[ti] ?? line).trim();
    if (!titleCell) continue;
    const parsed = parseTaskTokens(titleCell, projects, members);
    const row: ImportRow = { title: parsed.title || titleCell };
    if (parsed.priority) row.priority = parsed.priority;
    if (parsed.dueDate) row.dueDate = parsed.dueDate;
    if (parsed.projectId) row.projectId = parsed.projectId;
    if (parsed.assigneeId) row.assigneeId = parsed.assigneeId;
    // explicit columns win over inline tokens
    if (pri >= 0) { const p = (cells[pri] || "").trim().toLowerCase(); if (["low", "medium", "high", "urgent"].includes(p)) row.priority = p as Task["priority"]; }
    if (sti >= 0) { const s = (cells[sti] || "").trim().toLowerCase(); if (["todo", "progress", "review", "blocked", "done"].includes(s)) row.status = s as Task["status"]; }
    if (dui >= 0) { const d = (cells[dui] || "").trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) row.dueDate = d; }
    if (!row.projectId && defaultProjectId) row.projectId = defaultProjectId;
    out.push(row);
  }
  return out;
}

export function ImportTasksModal({ open, onClose, onImport, projects = [], members = [], defaultProjectId, defaultProjectName }: {
  open: boolean;
  onClose: () => void;
  onImport: (rows: ImportRow[]) => void;
  projects?: { id: string; name: string }[];
  members?: { id: string; name: string }[];
  defaultProjectId?: string;
  defaultProjectName?: string;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const rows = parseImportText(text, projects, members, defaultProjectId);

  const handleFile = (file: File) => {
    setError(null); setFileName(file.name);
    const ext = (file.name.toLowerCase().split(".").pop() || "");
    if (["xlsx", "xls", "numbers", "pdf", "docx", "pages"].includes(ext)) {
      setError(`Can't read ${ext.toUpperCase()} files directly. Open the file, select the rows, copy them, and paste into the box above — that handles spreadsheets and PDFs.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(file);
  };

  const doImport = () => {
    if (!rows.length) return;
    onImport(rows);
    setText(""); setFileName(""); setError(null);
    onClose();
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "color-mix(in oklch, var(--bg-deep) 55%, transparent)", backdropFilter: "blur(3px)" }} />
      <div role="dialog" aria-modal="true" aria-label="Import tasks" className="glass anim-scalein" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 91, width: 580, maxWidth: "94vw", maxHeight: "90vh", padding: 24, borderRadius: 20, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="arrowUpRight" size={18} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Import tasks</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-4)" }}>{defaultProjectName ? `Into ${defaultProjectName}` : "Paste a list, or copy rows from a spreadsheet"}</div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close" style={{ border: "none" }}><Icon name="x" size={18} /></button>
        </div>

        <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
          One task per line. Works with a plain list, or columns copied straight from Excel / Google Sheets (a <strong>Title</strong> column is detected automatically). You can add <span className="mono" style={{ color: "var(--ink-2)" }}>!high</span>, <span className="mono" style={{ color: "var(--ink-2)" }}>#project</span>, <span className="mono" style={{ color: "var(--ink-2)" }}>@person</span> or <span className="mono" style={{ color: "var(--ink-2)" }}>tomorrow</span> inline.
        </p>

        <textarea value={text} onChange={(e) => { setText(e.target.value); setError(null); }} autoFocus
          placeholder={"Draft Q3 deck !high tomorrow\nEmail the supplier\nReview budget #finance\n…"}
          style={{ width: "100%", minHeight: 170, resize: "vertical", padding: "12px 14px", borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6, outline: "none" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); if (fileRef.current) fileRef.current.value = ""; }} />
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} style={{ fontSize: 12.5 }}><Icon name="plus" size={14} /> Upload .csv / .txt</button>
          {fileName && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{fileName}</span>}
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: rows.length ? "var(--accent)" : "var(--ink-4)", fontWeight: 600 }}>{rows.length} task{rows.length === 1 ? "" : "s"} detected</span>
        </div>

        {error && <div style={{ fontSize: 12.5, color: "var(--prio-high)", background: "color-mix(in oklch, var(--prio-high) 10%, transparent)", borderRadius: 10, padding: "10px 12px", lineHeight: 1.5 }}>{error}</div>}

        {rows.length > 0 && (
          <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid var(--hairline)", borderRadius: 12, padding: 6 }}>
            {rows.slice(0, 50).map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: 12.5 }}>
                <Icon name="circle" size={6} style={{ color: "var(--ink-4)", flexShrink: 0 }} />
                <span className="truncate" style={{ flex: 1, color: "var(--ink-2)" }}>{r.title}</span>
                {r.priority && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{r.priority}</span>}
                {r.dueDate && <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{r.dueDate}</span>}
              </div>
            ))}
            {rows.length > 50 && <div style={{ padding: "5px 8px", fontSize: 11.5, color: "var(--ink-4)" }}>+ {rows.length - 50} more…</div>}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={doImport} disabled={!rows.length}>Import {rows.length || ""} task{rows.length === 1 ? "" : "s"}</button>
        </div>
      </div>
    </>
  );
}

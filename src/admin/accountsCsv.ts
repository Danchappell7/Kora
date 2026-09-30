/* ============================================================
   KANBO — admin console: Accounts → CSV export.
   Names and emails are typed by users, so every cell is neutralised
   against spreadsheet formula injection (OWASP "CSV injection"): a value
   that Excel, Numbers or Google Sheets would run as a formula gets a
   leading apostrophe, which they show as plain text.
   ============================================================ */
import type { AdminAccount } from "../data/store";

// = + - @ start a formula; a leading tab or carriage return can smuggle one in
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula-safe, quoted, with inner quotes doubled. */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (FORMULA_START.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export const ACCOUNT_CSV_HEAD = ["Name", "Email", "Joined", "Last active", "Approved", "Admin", "Suspended"];

/**
 * The accounts table as CSV text. Starts with a UTF-8 byte-order mark so
 * Excel reads accented names correctly, and uses CRLF line endings
 * (RFC 4180).
 */
export function accountsCsv(rows: AdminAccount[]): string {
  const body = rows.map((a) => [
    a.name, a.email, a.createdAt, a.updatedAt,
    a.approved === false ? "no" : "yes", a.isAdmin ? "yes" : "no", a.suspended ? "yes" : "no",
  ].map(csvCell).join(","));
  return "﻿" + [ACCOUNT_CSV_HEAD.map(csvCell).join(","), ...body].join("\r\n") + "\r\n";
}

/** Download the accounts table as `kanbo-accounts-YYYY-MM-DD.csv`. */
export function downloadAccountsCsv(rows: AdminAccount[]): void {
  const url = URL.createObjectURL(new Blob([accountsCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `kanbo-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoking straight away can cancel the download in some browsers
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

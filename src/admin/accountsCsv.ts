/* ============================================================
   KANBO — admin console: Accounts → CSV export.
   Names and emails are typed by users, so every cell is neutralised
   against spreadsheet formula injection (OWASP "CSV injection"): a value
   that Excel, Numbers or Google Sheets would run as a formula gets a
   leading apostrophe, which they show as plain text.
   ============================================================ */
import type { AdminAccount } from "../data/store";
import { csvCell, downloadCsv, toCsv } from "../lib/exportTasks";

/** One CSV cell: formula-safe, quoted, with inner quotes doubled (the shared task-export guard). */
export { csvCell };

export const ACCOUNT_CSV_HEAD = ["Name", "Email", "Joined", "Last active", "Approved", "Admin", "Suspended"];

/**
 * The accounts table as CSV text. Starts with a UTF-8 byte-order mark so
 * Excel reads accented names correctly, and uses CRLF line endings
 * (RFC 4180).
 */
export function accountsCsv(rows: AdminAccount[]): string {
  return toCsv([ACCOUNT_CSV_HEAD, ...rows.map((a) => [
    a.name, a.email, a.createdAt, a.updatedAt,
    a.approved === false ? "no" : "yes", a.isAdmin ? "yes" : "no", a.suspended ? "yes" : "no",
  ])]);
}

/** Download the accounts table as `kanbo-accounts-YYYY-MM-DD.csv`. */
export function downloadAccountsCsv(rows: AdminAccount[]): void {
  downloadCsv(`kanbo-accounts-${new Date().toISOString().slice(0, 10)}.csv`, accountsCsv(rows));
}

/* ============================================================
   KANBO — pure helpers for the reporting & manager views
   (Analytics, Reports, Workload, Goals, Portfolios, Automations).
   Kept free of JSX so the maths is unit-tested directly.
   ============================================================ */
import { useRef } from "react";
import type { Task, Goal, TagDef } from "../../data/types";

export const DAY_MS = 86400000;
export const round1 = (n: number): number => Math.round(n * 10) / 10;
/** "12.5h" — hours rounded to one decimal (no float noise like 40.300000000000004). */
export const fmtHours = (n: number): string => `${round1(n)}h`;

/* ---------------- CSV ---------------- */

/** One quoted CSV cell. Values that a spreadsheet would run as a formula
 *  (leading = + - @ tab or CR) get a leading apostrophe, so a task called
 *  `=HYPERLINK(...)` opens as text. Plain numbers ("-3", "4.5") are left alone. */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export const csvText = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

/** Save rows as a CSV file. The BOM makes Excel read names with accents as UTF-8. */
export function downloadCsv(rows: unknown[][], filename: string): void {
  const url = URL.createObjectURL(new Blob(["﻿" + csvText(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  // revoking synchronously can cancel the download in Safari/Firefox
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------------- dates ---------------- */

/** Local calendar day (00:00) for a date-only ISO ("2026-09-30") or a timestamp.
 *  Timestamps are converted to the viewer's own day, so work finished at 00:30
 *  BST on a Monday lands on Monday, not the previous (UTC) Sunday. */
export function localDay(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, dd] = iso.split("-").map(Number);
    d = new Date(y, m - 1, dd);
  } else {
    const t = new Date(iso);
    if (isNaN(t.getTime())) return null;
    d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }
  return isNaN(d.getTime()) ? null : d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Sep" — compact day + month that never wraps in chart axes (en-GB would give "Sept"). */
export const fmtDayMonth = (d: Date): string => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

export function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Monday 00:00 of the week containing `d` (UK convention: weeks start on Monday). */
export function startOfWeekMon(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** Whole local days from `a` to `b` (never negative). */
export function daysBetween(a: string, b: string): number {
  const da = localDay(a), db = localDay(b);
  if (!da || !db) return 0;
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / DAY_MS));
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const calendarDays = (a: Date, b: Date): number => (b < a ? 0 : Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1);
/** Mon–Fri days between a and b inclusive (arithmetic, so a year-long task costs nothing). */
export function workdays(a: Date, b: Date): number {
  const days = calendarDays(a, b);
  if (!days) return 0;
  const full = Math.floor(days / 7);
  let n = full * 5;
  for (let i = 0, dow = a.getDay(); i < days % 7; i++) { const x = (dow + i) % 7; if (x !== 0 && x !== 6) n++; }
  return n;
}

/* ---------------- Reports: weekly throughput ---------------- */

export interface WeeklyThroughput {
  /** week starts, oldest → newest; the LAST entry is the current (partial) week */
  weekStarts: Date[];
  created: number[];
  completed: number[];
  /** burnup lines — seeded with everything created/completed before the window */
  cumCreated: number[];
  cumCompleted: number[];
  /** avg completed per FULL week (the current partial week is left out) */
  velocity: number;
  /** later half of the full weeks minus the earlier half (tasks/week) */
  trend: number;
  totalCreated: number;
  totalDone: number;
}

/** `fullWeeks` complete Monday-start weeks plus the current week so far. */
export function weeklyThroughput(tasks: Task[], fullWeeks: number, today: Date): WeeklyThroughput {
  const thisWk = startOfWeekMon(today);
  const weekStarts = Array.from({ length: fullWeeks + 1 }, (_, i) => addDays(thisWk, -(fullWeeks - i) * 7));
  const n = weekStarts.length;
  const created: number[] = new Array(n).fill(0);
  const completed: number[] = new Array(n).fill(0);
  let baseCreated = 0, baseCompleted = 0;
  const bucketOf = (d: Date): number => { for (let i = n - 1; i >= 0; i--) if (d >= weekStarts[i]) return i; return -1; };
  for (const t of tasks) {
    const c = localDay(t.createdAt);
    // no creation date → treat as existing before the window, so the scope
    // line always contains every task that can appear as completed
    const cb = c ? bucketOf(c) : -1;
    if (cb >= 0) created[cb]++; else baseCreated++;
    if (t.status !== "done") continue;
    const d = localDay(t.completedAt);
    // a task can't finish before it existed (imports can carry older dates);
    // done-without-a-date is counted where it was created
    let b = d ? bucketOf(d) : cb;
    if (b < cb) b = cb;
    if (b >= 0) completed[b]++; else baseCompleted++;
  }
  let cc = baseCreated, cd = baseCompleted;
  const cumCreated = created.map((v) => (cc += v));
  const cumCompleted = completed.map((v) => (cd += v));
  const full = completed.slice(0, fullWeeks);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const velocity = fullWeeks > 0 ? round1(sum(full) / fullWeeks) : 0;
  const half = Math.floor(fullWeeks / 2);
  const trend = half > 0 ? round1(sum(full.slice(fullWeeks - half)) / half - sum(full.slice(0, half)) / half) : 0;
  return { weekStarts, created, completed, cumCreated, cumCompleted, velocity, trend, totalCreated: sum(created), totalDone: sum(completed) };
}

/* ---------------- Workload ---------------- */

export interface TaskWeekLoad { hours: number; overdue: boolean }

/** How much of an open task's estimate lands in the week starting `weekStart`.
 *  - due date only → the whole estimate lands in the week it's due
 *  - start → due  → the estimate is spread evenly over the working days of the span
 *  - late or started-and-undated work that is still open is carried into the current week
 *  - no dates at all → null (unscheduled; not counted against capacity) */
export function taskLoadInWeek(t: Task, weekStart: Date, today: Date): TaskWeekLoad | null {
  const due = localDay(t.dueDate), start = localDay(t.startDate);
  if (!due && !start) return null;
  const weekEnd = addDays(weekStart, 7);
  const lastDay = addDays(weekEnd, -1);
  const effort = Math.max(0, t.effortHours ?? 0);
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const overdue = !!due && due < todayMid;
  const isCurrent = todayMid >= weekStart && todayMid < weekEnd;
  const last = due ?? start!;
  // everything still open on a late task is due now, however long its span was
  if (overdue) return isCurrent ? { hours: effort, overdue } : null;
  if (last < weekStart) return isCurrent ? { hours: effort, overdue } : null;
  const first = start && due && start <= due ? start : last;
  if (first > lastDay) return null;
  if (first.getTime() === last.getTime()) return { hours: effort, overdue };
  const oa = first > weekStart ? first : weekStart;
  const ob = last < lastDay ? last : lastDay;
  const spanWork = workdays(first, last);
  const share = spanWork > 0 ? workdays(oa, ob) / spanWork : calendarDays(oa, ob) / calendarDays(first, last);
  if (share <= 0) return null;
  return { hours: effort * share, overdue };
}

export interface WorkloadRow {
  id: string;
  hours: number;
  items: { task: Task; hours: number; overdue: boolean }[];
  undated: number;
}

/** Open work per assignee for one week (see taskLoadInWeek). */
export function workloadForWeek(tasks: Task[], weekStart: Date, today: Date): { rows: Map<string, WorkloadRow>; undated: number } {
  const rows = new Map<string, WorkloadRow>();
  const row = (id: string) => { let r = rows.get(id); if (!r) { r = { id, hours: 0, items: [], undated: 0 }; rows.set(id, r); } return r; };
  let undated = 0;
  for (const t of tasks) {
    if (t.status === "done" || t.archivedAt) continue;
    const l = taskLoadInWeek(t, weekStart, today);
    if (!l) {
      if (!t.dueDate && !t.startDate) { undated++; row(t.assigneeId || "").undated++; }
      continue;
    }
    const r = row(t.assigneeId || "");
    r.hours += l.hours;
    r.items.push({ task: t, hours: l.hours, overdue: l.overdue });
  }
  rows.forEach((r) => r.items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.task.dueDate ?? "9999").localeCompare(b.task.dueDate ?? "9999")));
  return { rows, undated };
}

/* ---------------- Goals ---------------- */

/** Goals in tree order (each goal followed by its whole sub-tree), with depth.
 *  Goals whose parent is missing become top-level; goals caught in a parent
 *  cycle (A → B → A) are surfaced at the top level instead of disappearing. */
export function goalTree<G extends { id: string; parentId?: string }>(goals: G[]): { g: G; depth: number }[] {
  const ids = new Set(goals.map((g) => g.id));
  const kids = new Map<string, G[]>();
  const roots: G[] = [];
  for (const g of goals) {
    if (g.parentId && g.parentId !== g.id && ids.has(g.parentId)) {
      const a = kids.get(g.parentId) ?? []; a.push(g); kids.set(g.parentId, a);
    } else roots.push(g);
  }
  const out: { g: G; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (g: G, depth: number) => {
    if (seen.has(g.id)) return;
    seen.add(g.id); out.push({ g, depth });
    (kids.get(g.id) ?? []).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));
  goals.forEach((g) => { if (!seen.has(g.id)) walk(g, 0); });
  return out;
}

/** Every goal nested (at any depth) under `id`. */
export function goalDescendants<G extends { id: string; parentId?: string }>(goals: G[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of goals) if (g.parentId === cur && g.id !== id && !out.has(g.id)) { out.add(g.id); queue.push(g.id); }
  }
  return out;
}

export interface GoalProgress { pct: number; source: "project" | "subgoals" | "manual"; children: number }

/** Progress for every goal: a linked project drives it; otherwise a goal with
 *  sub-goals rolls up as the average of them; otherwise current / target. */
export function goalProgressMap(goals: Goal[], projectPct: (projectId: string) => number): Map<string, GoalProgress> {
  const ids = new Set(goals.map((g) => g.id));
  const kids = new Map<string, Goal[]>();
  for (const g of goals) if (g.parentId && g.parentId !== g.id && ids.has(g.parentId)) { const a = kids.get(g.parentId) ?? []; a.push(g); kids.set(g.parentId, a); }
  const memo = new Map<string, GoalProgress>();
  const visiting = new Set<string>();
  const manual = (g: Goal) => (g.target && g.target > 0 ? Math.max(0, Math.min(100, ((g.current ?? 0) / g.target) * 100)) : 0);
  const calc = (g: Goal): GoalProgress => {
    const hit = memo.get(g.id); if (hit) return hit;
    const children = kids.get(g.id) ?? [];
    let res: GoalProgress;
    if (g.projectId) res = { pct: projectPct(g.projectId), source: "project", children: children.length };
    else if (children.length && !visiting.has(g.id)) {
      visiting.add(g.id);
      const vals = children.filter((c) => !visiting.has(c.id)).map((c) => calc(c).pct);
      visiting.delete(g.id);
      res = vals.length ? { pct: vals.reduce((a, b) => a + b, 0) / vals.length, source: "subgoals", children: children.length } : { pct: manual(g), source: "manual", children: 0 };
    } else res = { pct: manual(g), source: "manual", children: 0 };
    memo.set(g.id, res);
    return res;
  };
  goals.forEach((g) => calc(g));
  memo.forEach((v, k) => memo.set(k, { ...v, pct: Math.round(v.pct) }));
  return memo;
}

/* ---------------- Portfolios: auto health (mirrors the project overview) ---------------- */

export type HealthKind = "complete" | "on_track" | "at_risk" | "off_track";
export interface ProjectHealth { kind: HealthKind; label: string; detail: string; overdue: number; blocked: number; total: number; pct: number }

export function projectHealth(tasks: Task[], today: Date): ProjectHealth | null {
  const total = tasks.length;
  if (!total) return null;
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const done = tasks.filter((t) => t.status === "done").length;
  const overdue = tasks.filter((t) => { if (t.status === "done") return false; const d = localDay(t.dueDate); return !!d && d < todayMid; }).length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const pct = Math.round((done / total) * 100);
  const bits: string[] = [];
  if (overdue) bits.push(`${overdue} overdue`);
  if (blocked) bits.push(`${blocked} blocked`);
  const detail = bits.length ? bits.join(" · ") : "nothing overdue or blocked";
  if (pct === 100) return { kind: "complete", label: "Complete", detail: "all tasks done", overdue, blocked, total, pct };
  if (overdue >= 3 || overdue / total > 0.25 || (overdue >= 1 && blocked >= 2)) return { kind: "off_track", label: "Off track", detail, overdue, blocked, total, pct };
  if (overdue >= 1 || blocked >= 1) return { kind: "at_risk", label: "At risk", detail, overdue, blocked, total, pct };
  return { kind: "on_track", label: "On track", detail, overdue, blocked, total, pct };
}

/* ---------------- Automations: tag values ---------------- */

/** The tag id an "Add tag" action value refers to: the id itself, or — for
 *  rules saved before the tag picker, which stored free text — the one tag
 *  whose label matches (case-insensitive). null when there's no single match. */
export function resolveTagId(value: string, tags: Record<string, TagDef>): string | null {
  if (!value) return null;
  if (tags[value]) return value;
  const want = value.trim().toLowerCase();
  const hits = Object.entries(tags).filter(([, t]) => t.label.trim().toLowerCase() === want);
  return hits.length === 1 ? hits[0][0] : null;
}

/* ---------------- stable list order ---------------- */

/** Keeps a list in a stable order across realtime reloads: by `position` when
 *  set, otherwise in the order items were first seen this session. (Postgres
 *  returns just-updated rows in a different place, which reshuffled goals,
 *  rules and forms after every edit.) */
export function useStableOrder<T extends { id: string; position?: number }>(items: T[]): T[] {
  const seen = useRef(new Map<string, number>());
  for (const it of items) if (!seen.current.has(it.id)) seen.current.set(it.id, seen.current.size);
  return [...items].sort((a, b) => ((a.position ?? Infinity) - (b.position ?? Infinity)) || (seen.current.get(a.id)! - seen.current.get(b.id)!));
}

/* ============================================================
   KANBO — Goals (a number you want to hit, with its progress) and
   Portfolios (projects rolled up: cards to manage them, a table to
   read them at a glance)
   ============================================================ */
import { useMemo, useState } from "react";
import { Avatar, Button, EmptyState, Icon, IconButton, Meter, Pill, ProjectDot, Segmented } from "../primitives";
import { getProject, getMember, KANBO_TODAY } from "../../data/data";
import type { Task, Project, Portfolio, StatusKind, StatusUpdate, Workspace } from "../../data/types";
import { projectHealth, useStableOrder, type HealthKind } from "./reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { fmtAge, fmtShortDay, FORMER_MEMBER, indexTasks, isStale, oldestTaskAge, projectUpdates, statusFacts, STALE_DAYS, updateAuthor, type TaskIndex } from "../../lib/statusDraft";
import { combinedProgress, progressOf } from "../../lib/countRules";
import { WorkspaceMark } from "../businesses/Businesses";
import { shortName } from "../../lib/businesses";
import "../project/projects.css";

/* Portfolios live in components/portfolios (re-exported below, so they share this page's chunk). */
type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";

export const STATUS_KIND_META: Record<StatusKind, { label: string; color: string }> = {
  on_track: { label: "On track", color: "var(--st-done)" },
  at_risk: { label: "At risk", color: "var(--st-review)" },
  off_track: { label: "Off track", color: "var(--prio-urgent)" },
  on_hold: { label: "On hold", color: "var(--ink-4)" },
};
const KIND_TONE: Record<StatusKind, Tone> = { on_track: "ok", at_risk: "warn", off_track: "signal", on_hold: "neutral" };
const HEALTH_TONE: Record<HealthKind, Tone> = { complete: "ok", on_track: "ok", at_risk: "warn", off_track: "signal" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Maya" for Maya Lin; "Former member" stays whole */
const firstName = (name: string) => (name === FORMER_MEMBER ? name : name.split(/\s+/)[0] || name);

/** An inline "add" row: a name field with Add and Cancel. */
function Adder({ label, placeholder, onAdd, onCancel }: { label: string; placeholder: string; onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) onAdd(n); };
  return (
    <div className="kpj-adder">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus className="kpj-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={label}
        onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <Button variant="primary" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

/* ---------------- GOALS ---------------- */
// (the Goals page lives in components/goals since Goals 2.0; it's still reachable from here)
export { GoalsView } from "../goals/GoalsView";

/* ---------------- PORTFOLIOS ---------------- */
export { PortfoliosView } from "../portfolios/PortfoliosView";
// 0054: a portfolio's own page, in the same lazily loaded chunk
export { PortfolioPage } from "../portfolios/PortfolioPage";

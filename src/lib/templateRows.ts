/* ============================================================
   KANBO — task_templates rows → LibraryTemplate; limits; errors.
   lib/rows0048 re-exports these.                   [architect: final]
   ============================================================ */
import type { LibraryTemplate, Priority, TaskTemplateBody, TemplateAssigneeRole, TemplateFailure, TemplateSubtask } from "../data/types";
import { bool, errText, isMissing, isNetwork, isObj, num, str, strArr, strOr } from "./rowUtils";

export const TEMPLATE_LIMITS = { name: 80, emoji: 16, bodyBytes: 32768, title: 500, subtasks: 50, checklist: 50, perPerson: 300 } as const;

const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "urgent"];
const ROLES: readonly TemplateAssigneeRole[] = ["me", "project_owner", "unassigned"];

/** task_templates.body → TaskTemplateBody, or null without a title. Clamps to the database's limits. */
export function parseTemplateBody(raw: unknown): TaskTemplateBody | null {
  if (!isObj(raw) || typeof raw.title !== "string") return null;
  const b: TaskTemplateBody = { title: raw.title.slice(0, TEMPLATE_LIMITS.title) };
  if (typeof raw.description === "string") b.description = raw.description;
  if (typeof raw.priority === "string" && (PRIORITIES as readonly string[]).includes(raw.priority)) b.priority = raw.priority as Priority;
  const est = num(raw.estimate);
  if (est !== null && est > 0) b.estimate = Math.round(est);
  if (Array.isArray(raw.tags)) b.tags = strArr(raw.tags, 20);
  const due = num(raw.dueOffsetDays);
  if (due !== null) b.dueOffsetDays = Math.round(due);
  if (Array.isArray(raw.subtasks)) {
    b.subtasks = raw.subtasks.filter(isObj).filter((s) => typeof s.title === "string" && s.title.trim()).slice(0, TEMPLATE_LIMITS.subtasks)
      .map((s): TemplateSubtask => {
        const out: TemplateSubtask = { title: String(s.title) };
        const off = num(s.offsetDays);
        if (off !== null) out.offsetDays = Math.round(off);
        if (typeof s.assigneeRole === "string" && (ROLES as readonly string[]).includes(s.assigneeRole)) out.assigneeRole = s.assigneeRole as TemplateAssigneeRole;
        return out;
      });
  }
  if (Array.isArray(raw.checklist)) b.checklist = strArr(raw.checklist, TEMPLATE_LIMITS.checklist).filter((x) => x.trim());
  return b;
}

/** A task_templates row → LibraryTemplate, or null. */
export function parseLibraryTemplate(raw: unknown): LibraryTemplate | null {
  if (!isObj(raw)) return null;
  const g = (snake: string, camel: string) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  const id = str(raw.id), name = str(raw.name), body = parseTemplateBody(raw.body);
  if (!id || !name || !body) return null;
  const builtin = id.startsWith("builtin-");
  const out: LibraryTemplate = {
    id, name, body,
    workspaceId: str(g("workspace_id", "workspaceId")),
    userId: strOr(g("user_id", "userId"), ""),
    emoji: str(raw.emoji),
    shared: bool(raw.shared),
    createdAt: strOr(g("created_at", "createdAt"), ""),
    updatedAt: strOr(g("updated_at", "updatedAt"), ""),
  };
  if (builtin) out.builtin = true;
  return out;
}

export function templateFailure(e: unknown): TemplateFailure {
  const m = errText(e);
  if (isMissing(m)) return "unavailable";
  if (/too many task templates/i.test(m)) return "too_many";
  if (/row-level security|permission denied|not authorized/i.test(m)) return "not_allowed";
  if (/task_templates_shape|check constraint|invalid/i.test(m)) return "invalid";
  if (/not found|0 rows|PGRST116/i.test(m)) return "not_found";
  if (isNetwork(m)) return "network";
  return "error";
}

/* ============================================================
   KANBO — the lock after a project's name (0058 project access): a
   small padlock on Members only and Private projects, only where the
   workspace has project access on. Its words are for screen readers
   (", private") and the tooltip says who can see it. Nothing at all
   before 0058, with the switch off, or on a Whole workspace project.
   ============================================================ */
import { WORKSPACES } from "../../data/data";
import type { Project, Workspace } from "../../data/types";
import { accessOn, visibilityOf } from "../../lib/projectAccess";
import { Icon } from "./Icon";
import "./projectLock.css";

const WORDS = {
  private: { sr: ", private", title: "Private: only its people can see it", label: "Private" },
  members: { sr: ", members only", title: "Members only: its people, plus owners and admins", label: "Members only" },
} as const;

/** Is this project closed to part of its workspace (and should it wear the lock)? */
export function projectLocked(project: Pick<Project, "workspaceId" | "visibility"> | undefined | null, workspaces: Workspace[] = WORKSPACES): "members" | "private" | null {
  if (!project?.workspaceId) return null;
  const v = visibilityOf(project);
  if (v === "workspace") return null;
  return accessOn(workspaces.find((w) => w.id === project.workspaceId)) ? v : null;
}

/** The lock glyph, or the lock and its word ("chip": the project header and its access chip). */
export function ProjectLock({ project, workspaces, size = 12, chip = false, className, onClick }: {
  project: Pick<Project, "workspaceId" | "visibility"> | undefined | null;
  /** (defaults to the app's workspaces) */
  workspaces?: Workspace[];
  size?: number;
  chip?: boolean;
  className?: string;
  /** the chip as a button (the project header's: opens People & access) */
  onClick?: () => void;
}): JSX.Element | null {
  const kind = projectLocked(project, workspaces);
  if (!kind) return null;
  const w = WORDS[kind];
  if (chip && onClick) {
    return (
      <button type="button" className={["kplock-chip", className].filter(Boolean).join(" ")} title={`${w.title}. Open People & access`} data-kind={kind} onClick={onClick}>
        <Icon name="lock" size={size} sw={2} />{w.label}
      </button>
    );
  }
  if (chip) {
    return (
      <span className={["kplock-chip", className].filter(Boolean).join(" ")} title={w.title} data-kind={kind}>
        <Icon name="lock" size={size} sw={2} />{w.label}
      </span>
    );
  }
  return (
    <span className={["kplock", className].filter(Boolean).join(" ")} title={w.title} data-kind={kind}>
      <Icon name="lock" size={size} sw={2} />
      <span className="kplock-sr">{w.sr}</span>
    </span>
  );
}

/* ============================================================
   KANBO — project identity primitives: ProjectTile, ProjectCover,
   ProjectChip. Every project wears one of twelve spectrum hues
   (lib/projectIdentity.ts); these carry it into the sidebar, lists,
   the task panel, the directory and the project page. Colour comes
   from CSS (kanbo.css "Project identity"), so a theme switch needs no
   re-render. Import from "components/primitives".
   ============================================================ */
import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type MouseEventHandler, type ReactNode } from "react";
import { Icon } from "./Icon";
import { projectGlyph, projectIdentity, type ProjectIdentityInput } from "../../lib/projectIdentity";

/** A project, or nothing (a deleted or unknown project renders a neutral mark). */
export type ProjectLike = ProjectIdentityInput | null | undefined;
export type ProjectTileSize = 16 | 20 | 28 | 44 | 64;

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

/* ============================== ProjectTile ============================== */

export interface ProjectTileProps {
  project: ProjectLike;
  /** 16 (chips, rows) · 20 (sidebar) · 28 · 44 (directory cards) · 64 (project page). Default 20. */
  size?: ProjectTileSize;
  /** Decorative by default: the name always sits beside it. A title makes it an image named by the title. */
  title?: string;
  /** Draws a 4px ring of the surface below (and a soft lift): for the tile that overlaps a cover's edge. */
  ring?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** The project's emoji (or the initial of its name, in its ink) on its tint, a rounded square at 25% radius. */
export function ProjectTile({ project, size = 20, title, ring, className, style }: ProjectTileProps) {
  const glyph = projectGlyph(project);
  const id = project ? projectIdentity(project) : null;
  return (
    <span
      className={cx("kp", "kptile", className)}
      data-size={size}
      data-glyph={project ? glyph.kind : "none"}
      data-empty={project ? undefined : "true"}
      data-ring={ring ? "true" : undefined}
      data-spectrum={id?.key}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      title={title}
      style={id ? { ...id.style, ...style } : style}
    >
      {project && glyph.text}
    </span>
  );
}

/* ============================== ProjectCover ============================== */

export interface ProjectCoverProps {
  project: ProjectLike;
  /** "card": 96px (directory cards) · "page": 140px, 104px on phones (the project header). Default "card". */
  size?: "card" | "page";
  /** An explicit band height in px, overriding `size`. */
  height?: number;
  /** Overlap a tile of this size on the cover's bottom edge, half on and half off (44 for cards, 64 for the page). */
  tile?: 28 | 44 | 64;
  /** Reserve room below the band for the tile's overhang, so the next element clears it. Default true. */
  reserve?: boolean;
  /** Where the tile sits from the left edge, in px. Default 16 (card) or the page gutter (page). */
  tileInset?: number;
  /** The surface the cover settles into (its bottom scrim and the tile's ring). Default "bg": the page. */
  surface?: "bg" | "surface" | "raised";
  /** Corner radius of the band, in px. Default 0 (a card clips it with its own radius). */
  radius?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * The generated cover band: the project's hue running into its spectrum
 * neighbour, a diagonal light sweep, very faint grain and a scrim into the
 * surface below. No text sits on it; the tile is the only thing that may
 * overlap it. Purely decorative (aria-hidden) and static.
 */
export function ProjectCover({ project, size = "card", height, tile, reserve = true, tileInset, surface = "bg", radius, className, style }: ProjectCoverProps) {
  const id = project ? projectIdentity(project) : null;
  const vars: Record<string, string> = {};
  if (height != null) vars["--kpc-h"] = `${height}px`;
  if (tileInset != null) vars["--kpc-inset"] = `${tileInset}px`;
  if (radius != null) vars["--kpc-r"] = `${radius}px`;
  return (
    <div
      className={cx("kp", "kpcover-wrap", className)}
      data-size={size}
      data-surface={surface === "bg" ? undefined : surface}
      data-tile={tile}
      data-reserve={tile && reserve ? "true" : undefined}
      data-spectrum={id?.key}
      style={{ ...(id?.style as CSSProperties | undefined), ...(vars as CSSProperties), ...style }}
    >
      <div className="kpcover" aria-hidden="true" data-empty={project ? undefined : "true"} />
      {tile && <ProjectTile project={project} size={tile} ring />}
    </div>
  );
}

/* ============================== ProjectChip ============================== */

export interface ProjectChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> {
  project: ProjectLike;
  /** Makes the chip a button (it washes in the project's tint on hover). Without it the chip is plain text. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** A trailing crumb after a chevron: the section in the task panel ("Q3 Product Launch › Narrative"). */
  suffix?: ReactNode;
  /** "sm": 12px text, 22px tall (rows) · "md": 13px, 24px (panels). Default "sm". */
  size?: "sm" | "md";
  /** What a missing project reads as. Default "No project". */
  emptyLabel?: string;
}

/** Tile (16) plus the project's name in --ink-2; used in rows, the task panel and results. */
export const ProjectChip = forwardRef<HTMLButtonElement, ProjectChipProps>(function ProjectChip(
  { project, onClick, suffix, size = "sm", emptyLabel = "No project", className, style, type, ...rest },
  ref,
) {
  const id = project ? projectIdentity(project) : null;
  const name = project?.name?.trim() || (project ? "Untitled project" : emptyLabel);
  const inner = (
    <>
      <ProjectTile project={project} size={16} />
      <span className="kpchip-name">{name}</span>
      {suffix != null && suffix !== false && suffix !== "" && (
        <>
          <span className="kpchip-sep" aria-hidden="true"><Icon name="chevronRight" size={12} /></span>
          <span className="kpchip-suffix">{suffix}</span>
        </>
      )}
    </>
  );
  const common = {
    className: cx("kp", "kpchip", className),
    "data-size": size,
    "data-empty": project ? undefined : "true",
    "data-spectrum": id?.key,
    style: id ? { ...id.style, ...style } : style,
  };
  if (onClick) {
    // a text crumb joins the name as "Project, Section" (the chevron is never announced)
    const label = typeof suffix === "string" || typeof suffix === "number" ? `${name}, ${suffix}` : undefined;
    return <button ref={ref} type={type ?? "button"} onClick={onClick} aria-label={label} {...common} {...rest}>{inner}</button>;
  }
  return <span {...common} id={rest.id} title={rest.title}>{inner}</span>;
});

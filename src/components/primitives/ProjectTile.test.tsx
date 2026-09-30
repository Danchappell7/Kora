import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import * as primitives from "./index";
import { ProjectTile, ProjectCover, ProjectChip } from "./ProjectTile";
import { spectrumColor } from "../../lib/projectIdentity";
import type { Project } from "../../data/types";

const LAUNCH: Project = { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: spectrumColor("sky"), workspaceId: "ws" };
const PLAIN: Project = { id: "p-plain", name: "quarterly review", emoji: "", color: spectrumColor("jade"), workspaceId: "ws" };
const hueOf = (el: Element) => (el as HTMLElement).style.getPropertyValue("--p-h");

describe("primitives index", () => {
  it("re-exports the identity primitives and the spectrum helpers", () => {
    for (const name of ["ProjectTile", "ProjectCover", "ProjectChip", "projectIdentity", "projectHue", "projectSpectrum", "spectrumColor", "SPECTRUM"]) {
      expect(primitives, name).toHaveProperty(name);
    }
  });
});

describe("ProjectTile", () => {
  it("shows the emoji on the project's hue, decorative by default (the name always sits beside it)", () => {
    const { container } = render(<ProjectTile project={LAUNCH} size={28} />);
    const tile = container.querySelector(".kptile")!;
    expect(tile).toHaveTextContent("🚀");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile).toHaveClass("kp");
    expect(tile).toHaveAttribute("data-size", "28");
    expect(tile).toHaveAttribute("data-glyph", "emoji");
    expect(tile).toHaveAttribute("data-spectrum", "sky");
    expect(hueOf(tile)).toBe("225");
    expect((tile as HTMLElement).style.getPropertyValue("--p-fc")).toBe("0.73");
  });

  it("defaults to 20px and falls back to the name's initial when there is no emoji", () => {
    const { container } = render(<ProjectTile project={PLAIN} />);
    const tile = container.querySelector(".kptile")!;
    expect(tile).toHaveAttribute("data-size", "20");
    expect(tile).toHaveAttribute("data-glyph", "initial");
    expect(tile).toHaveTextContent(/^Q$/);
    expect(hueOf(tile)).toBe("158");
  });

  it("becomes an image named by its title when it stands alone", () => {
    render(<ProjectTile project={LAUNCH} size={16} title="Q3 Product Launch" />);
    const img = screen.getByRole("img", { name: "Q3 Product Launch" });
    expect(img).not.toHaveAttribute("aria-hidden");
  });

  it("renders a neutral, empty tile for a missing project", () => {
    const { container } = render(<ProjectTile project={undefined} size={44} />);
    const tile = container.querySelector(".kptile")!;
    expect(tile).toHaveAttribute("data-empty", "true");
    expect(tile).toHaveTextContent("");
    expect(hueOf(tile)).toBe("");
  });

  it("draws the surface ring only when asked", () => {
    const { container } = render(<><ProjectTile project={LAUNCH} /><ProjectTile project={LAUNCH} size={64} ring /></>);
    const [plain, ringed] = Array.from(container.querySelectorAll(".kptile"));
    expect(plain).not.toHaveAttribute("data-ring");
    expect(ringed).toHaveAttribute("data-ring", "true");
  });

  it("keeps a caller's style alongside the identity variables", () => {
    const { container } = render(<ProjectTile project={LAUNCH} style={{ marginRight: 6 }} />);
    const tile = container.querySelector(".kptile") as HTMLElement;
    expect(tile.style.marginRight).toBe("6px");
    expect(hueOf(tile)).toBe("225");
  });
});

describe("ProjectCover", () => {
  it("is a decorative band on the project's hue, with no text on it", () => {
    const { container } = render(<ProjectCover project={LAUNCH} />);
    const wrap = container.querySelector(".kpcover-wrap")!;
    const band = container.querySelector(".kpcover")!;
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect(band).toHaveTextContent("");
    expect(wrap).toHaveClass("kp");
    expect(wrap).toHaveAttribute("data-size", "card");
    expect(hueOf(wrap)).toBe("225");
    expect(container.querySelector(".kptile")).toBeNull();
    expect(wrap).not.toHaveAttribute("data-reserve");
  });

  it("overlaps a ringed tile on its bottom edge and reserves room for the overhang", () => {
    const { container } = render(<ProjectCover project={LAUNCH} size="page" tile={64} />);
    const wrap = container.querySelector(".kpcover-wrap")!;
    expect(wrap).toHaveAttribute("data-size", "page");
    expect(wrap).toHaveAttribute("data-tile", "64");
    expect(wrap).toHaveAttribute("data-reserve", "true");
    const tile = wrap.querySelector(":scope > .kptile")!;
    expect(tile).toHaveAttribute("data-size", "64");
    expect(tile).toHaveAttribute("data-ring", "true");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile).toHaveTextContent("🚀");
  });

  it("takes an explicit height, inset, radius and the surface it settles into", () => {
    const { container } = render(<ProjectCover project={LAUNCH} height={104} tile={44} reserve={false} tileInset={20} radius={12} surface="surface" />);
    const wrap = container.querySelector(".kpcover-wrap") as HTMLElement;
    expect(wrap.style.getPropertyValue("--kpc-h")).toBe("104px");
    expect(wrap.style.getPropertyValue("--kpc-inset")).toBe("20px");
    expect(wrap.style.getPropertyValue("--kpc-r")).toBe("12px");
    expect(wrap).toHaveAttribute("data-surface", "surface");
    expect(wrap).not.toHaveAttribute("data-reserve");
  });

  it("stays neutral for a missing project", () => {
    const { container } = render(<ProjectCover project={null} tile={44} />);
    expect(container.querySelector(".kpcover")).toHaveAttribute("data-empty", "true");
    expect(container.querySelector(".kptile")).toHaveAttribute("data-empty", "true");
  });
});

describe("ProjectChip", () => {
  it("is plain text (tile + name) unless it does something", () => {
    const { container } = render(<ProjectChip project={LAUNCH} />);
    expect(screen.queryByRole("button")).toBeNull();
    const chip = container.querySelector(".kpchip")!;
    expect(chip.tagName).toBe("SPAN");
    expect(chip).toHaveTextContent("Q3 Product Launch");
    expect(chip.querySelector(".kptile")).toHaveAttribute("data-size", "16");
    expect(chip.querySelector(".kptile")).toHaveAttribute("aria-hidden", "true");
    expect(chip).toHaveAttribute("data-size", "sm");
    expect(hueOf(chip)).toBe("225"); // the chip itself scopes --p-tint for its hover
  });

  it("is a button named by the project when clickable, and forwards its ref", () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(<ProjectChip ref={ref} project={LAUNCH} onClick={onClick} size="md" />);
    const btn = screen.getByRole("button", { name: "Q3 Product Launch" });
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toHaveAttribute("data-size", "md");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(btn);
  });

  it("reads a section crumb as part of its name, without announcing the chevron", () => {
    render(<ProjectChip project={LAUNCH} suffix="Narrative" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Q3 Product Launch, Narrative" })).toBeInTheDocument();
  });

  it("names a missing project plainly", () => {
    const { container, rerender } = render(<ProjectChip project={undefined} />);
    expect(container.querySelector(".kpchip")).toHaveAttribute("data-empty", "true");
    expect(container.querySelector(".kpchip")).toHaveTextContent("No project");
    rerender(<ProjectChip project={null} emptyLabel="Inbox" />);
    expect(container.querySelector(".kpchip")).toHaveTextContent("Inbox");
    rerender(<ProjectChip project={{ ...LAUNCH, name: "  " }} />);
    expect(container.querySelector(".kpchip")).toHaveTextContent("Untitled project");
  });
});

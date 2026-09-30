import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Check, Segmented, avatarPaint, chipInk, Icon, StatusDot, PriorityFlag } from "./index";
import type { Status, Priority } from "../../data/types";
import { contrast, legibleFill, parseColor, oklchToRgb, DARK_INK, LIGHT_INK } from "../../lib/contrast";

describe("Check", () => {
  it("is a checkbox named after its item, with a stable name as the state flips", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Check done={false} label="Write the launch brief" onToggle={onToggle} />);
    const box = screen.getByRole("checkbox", { name: "Done: Write the launch brief" });
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<Check done label="Write the launch brief" onToggle={onToggle} />);
    expect(screen.getByRole("checkbox", { name: "Done: Write the launch brief" })).toHaveAttribute("aria-checked", "true");
  });

  it("still has an accessible name without a label", () => {
    render(<Check done={false} />);
    expect(screen.getByRole("checkbox", { name: "Done" })).toBeInTheDocument();
  });

  it("takes a full name when it isn't a completion box (a yes/no custom field)", () => {
    render(<Check done name="Approved" label="ignored" />);
    const box = screen.getByRole("checkbox", { name: "Approved" });
    expect(box).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("checkbox", { name: /Done/ })).toBeNull();
  });
});

describe("Segmented", () => {
  it("exposes the selected option with aria-pressed inside a named group", () => {
    const onChange = vi.fn();
    render(<Segmented ariaLabel="View" value="list" onChange={onChange}
      options={[{ value: "list", label: "List" }, { value: "board", label: "Board" }]} />);
    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    const board = screen.getByRole("button", { name: "Board" });
    expect(board).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(board);
    expect(onChange).toHaveBeenCalledWith("board");
  });
});

describe("avatar initials stay legible on any profile colour", () => {
  const liftedRgb = (color: string, fill: string) => {
    const pct = fill.match(/white (\d+)%/);
    if (!pct) return parseColor(color)!;
    const [L, C, H] = color.match(/[\d.]+/g)!.map(Number);
    const p = +pct[1] / 100;
    return oklchToRgb(L + (1 - L) * p, C * (1 - p), H);
  };
  it.each([
    "oklch(0.585 0.196 264)", // old default self violet: neither ink passed
    "oklch(0.74 0.14 230)", "oklch(0.78 0.15 70)", "oklch(0.74 0.16 305)", "oklch(0.7 0.13 20)", "oklch(0.75 0.13 155)",
    "oklch(0.35 0.15 264)", "#1f6feb", "#f0a93b", "#8a8f98",
  ])("%s", (color) => {
    const { fill, ink } = legibleFill(color);
    const inkRgb = parseColor(ink === "light" ? LIGHT_INK : DARK_INK)!;
    expect(contrast(inkRgb, liftedRgb(color, fill))).toBeGreaterThanOrEqual(4.5);
  });
  it("uses the themed ink token for dark initials and caches per colour", () => {
    const a = avatarPaint("oklch(0.78 0.15 70)");
    expect(a).toEqual({ fill: "oklch(0.78 0.15 70)", ink: "var(--avatar-ink)" });
    expect(avatarPaint("oklch(0.78 0.15 70)")).toBe(a);
    expect(avatarPaint("oklch(0.585 0.196 264)").fill).toMatch(/^color-mix\(in oklch, oklch\(0\.585 0\.196 264\), white \d+%\)$/);
  });
});

describe("chip ink", () => {
  it("mixes toward the theme's ink colour by the theme's shift", () => {
    expect(chipInk("oklch(0.78 0.15 70)")).toBe("color-mix(in oklch, oklch(0.78 0.15 70), var(--chip-ink-mix, black) var(--chip-ink-shift, 0%))");
  });
});

describe("Icon", () => {
  it("is decorative by default: hidden from assistive tech and out of the Tab order", () => {
    const { container } = render(<button type="button" aria-label="Archive project Q4 Launch"><Icon name="archive" /></button>);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(screen.getByRole("button", { name: "Archive project Q4 Launch" })).toBeInTheDocument();
  });

  it("becomes a named image when it carries meaning on its own", () => {
    render(<Icon name="lock" aria-label="Private project" />);
    const img = screen.getByRole("img", { name: "Private project" });
    expect(img).not.toHaveAttribute("aria-hidden");
  });
});

describe("status and priority don't rely on colour alone", () => {
  /** a fingerprint of the drawn shapes (element + fill/stroke role), colour-free */
  const shape = (el: Element) => Array.from(el.querySelectorAll("svg > *"))
    .map((n) => `${n.tagName}:${n.getAttribute("d") ?? ""}:${n.getAttribute("fill") === "none" ? "outline" : "filled"}`).join("|");

  it("gives every status its own shape, at the smallest size the app uses", () => {
    const statuses: Status[] = ["todo", "progress", "review", "blocked", "done"];
    const shapes = statuses.map((s) => { const { container, unmount } = render(<StatusDot status={s} size={6} />); const f = shape(container); unmount(); return f; });
    expect(new Set(shapes).size).toBe(statuses.length);
  });

  it("marks urgent with an exclamation beside the flag, so it differs from high by shape", () => {
    const flags = (["urgent", "high", "medium"] as Priority[]).map((p) => { const { container, unmount } = render(<PriorityFlag priority={p} />); const f = shape(container); unmount(); return f; });
    expect(flags[0]).not.toBe(flags[1]);
    expect(flags[0]).toMatch(/M20\.5 4v5\.2/);
    expect(flags[1]).not.toMatch(/M20\.5/);
    // high is filled, medium is an outline
    expect(flags[1]).not.toBe(flags[2]);
  });

  it("keeps the dot and flag out of the accessibility tree (callers name them)", () => {
    const { container } = render(<><StatusDot status="blocked" /><PriorityFlag priority="urgent" /></>);
    container.querySelectorAll("svg").forEach((svg) => expect(svg).toHaveAttribute("aria-hidden", "true"));
    expect(screen.getByTitle("Urgent priority")).toBeInTheDocument();
  });
});

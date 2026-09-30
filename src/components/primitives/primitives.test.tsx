import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Check, Segmented, avatarPaint, chipInk } from "./index";
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

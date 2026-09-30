import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Check, Segmented, avatarPaint, chipInk, Icon, StatusDot, PriorityFlag, Avatar, AvatarStack, Tag, AiScore, AppBg, EmptyArt, KanboGlyph } from "./index";
import { MEMBERS } from "../../data/data";
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

  it("draws priority as ascending bars and urgent as a square with a knocked-out \"!\", so no two levels share a shape", () => {
    /** the bars that are drawn at full strength (the rest are faint placeholders) */
    const solidBars = (el: Element) => Array.from(el.querySelectorAll("svg > rect")).filter((r) => r.getAttribute("opacity") !== "0.5").length;
    const draw = (p: Priority) => { const { container, unmount } = render(<PriorityFlag priority={p} />); const out = { shape: shape(container), bars: solidBars(container), mask: !!container.querySelector("mask") }; unmount(); return out; };
    const [urgent, high, medium, low] = (["urgent", "high", "medium", "low"] as Priority[]).map(draw);
    expect(urgent.mask).toBe(true);              // the "!" is a real hole, not a colour
    expect(urgent.shape).not.toBe(high.shape);
    expect([low.bars, medium.bars, high.bars]).toEqual([1, 2, 3]);
    expect(high.mask || medium.mask || low.mask).toBe(false);
  });

  it("keeps the dot and flag out of the accessibility tree (callers name them)", () => {
    const { container } = render(<><StatusDot status="blocked" /><PriorityFlag priority="urgent" /></>);
    container.querySelectorAll("svg").forEach((svg) => expect(svg).toHaveAttribute("aria-hidden", "true"));
    expect(screen.getByTitle("Urgent priority")).toBeInTheDocument();
  });
});

describe("Paper & Navy restyle (same props, same names)", () => {
  it("draws an avatar as a tinted disc in the member's hue, initials at least 10px", () => {
    const m = MEMBERS.find((x) => x.color.startsWith("oklch(0.74 0.14 230)"))!;
    render(<><Avatar id={m.id} size={20} /><AvatarStack ids={[m.id]} size={32} /></>);
    const [small, big] = screen.getAllByTitle(m.name);
    expect(small.style.background).toBe("oklch(var(--av-bg-l) var(--av-bg-c) 230)");
    expect(small.style.color).toBe("oklch(var(--av-fg-l) var(--av-fg-c) 230)");
    expect(parseFloat(small.style.fontSize)).toBe(10);
    expect(parseFloat(big.style.fontSize)).toBe(13);
  });

  it("shows a tag as a dot and a word, not a filled pill", () => {
    const { container } = render(<Tag id="design" />);
    expect(screen.getByText("Design")).toBeInTheDocument();
    const dot = container.querySelector(".ktag-dot") as HTMLElement;
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot.style.background).toBe("oklch(var(--pl, 0.62) 0.16 305)");
    expect((container.firstChild as HTMLElement).style.backgroundColor).toBe("");
  });

  it("paints status dots with the glyph-weight fill tokens and never pulses", () => {
    const { container } = render(<StatusDot status="progress" glow />);
    const circle = container.querySelector("circle")!;
    expect(circle.getAttribute("stroke")).toBe("var(--st-progress-fill, var(--st-progress))");
    expect(container.querySelectorAll("[data-status] > span")).toHaveLength(0);
  });

  it("keeps the square checkbox at 16px by default", () => {
    render(<Check done={false} label="Draft" />);
    expect(screen.getByRole("checkbox", { name: "Done: Draft" })).toHaveStyle({ width: "16px", height: "16px" });
  });

  it("scores with Kanbo's mark, never a sparkle", () => {
    const { container } = render(<AiScore score={92} reason="Due today and blocks two tasks" />);
    const score = container.querySelector(".ai-score")!;
    expect(score).toHaveAttribute("data-tip", "Due today and blocks two tasks");
    expect(score).toHaveAttribute("data-tone", "high");
    expect(score.querySelector(".kaimark")).not.toBeNull();
    expect(score).toHaveTextContent("92");
  });

  it("draws a static backdrop (the halo lives in CSS)", () => {
    const { container } = render(<AppBg grid />);
    const bg = container.querySelector(".app-bg")!;
    expect(bg).toHaveAttribute("aria-hidden", "true");
    expect(bg.getAttribute("style")).toBeNull();
  });

  it("gives empty-state art exactly one accent element, at 96px by default", () => {
    for (const kind of ["tasks", "inbox", "calendar", "chart", "search", "users"]) {
      const { container, unmount } = render(<EmptyArt kind={kind} />);
      const svg = container.querySelector("svg")!;
      expect(svg).toHaveAttribute("width", "96");
      const accents = Array.from(svg.querySelectorAll("*")).filter((n) => /var\(--accent\)/.test((n.getAttribute("style") ?? "") + (n.getAttribute("stroke") ?? "")));
      expect(accents.length, kind).toBeGreaterThanOrEqual(1);
      expect(accents.length, kind).toBeLessThanOrEqual(2); // a mark and, at most, the stroke that carries it
      unmount();
    }
  });

  it("KanboGlyph is decorative by default, gradient-filled on request with its own id", () => {
    const { container } = render(<><KanboGlyph /><KanboGlyph gradient /><KanboGlyph gradient title="Kanbo" /></>);
    const svgs = container.querySelectorAll("svg");
    expect(svgs[0]).toHaveAttribute("aria-hidden", "true");
    expect(svgs[0].querySelector("rect")).toHaveAttribute("fill", "currentColor");
    const ids = Array.from(container.querySelectorAll("linearGradient")).map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByRole("img", { name: "Kanbo" })).toBe(svgs[2]);
  });
});

describe("AvatarStack", () => {
  it("tucks each disc under the last only as far as keeps its initials whole (clear of that disc and its 1.5px ring)", async () => {
    const { avatarStackOverlap } = await import("./index");
    for (const size of [20, 22, 24, 28, 32, 40]) {
      const type = Math.max(10, Math.round(size * 0.42));
      const margin = (size - type * 1.4) / 2;          // the clear space beside two initials
      const o = avatarStackOverlap(size);
      expect(o).toBeGreaterThanOrEqual(1);              // still reads as a stack
      expect(o).toBeLessThanOrEqual(size * 0.25);
      expect(o + 1.5).toBeLessThanOrEqual(margin + 0.25);
    }
  });

  it("stacks with that overlap", () => {
    const { container } = render(<AvatarStack ids={["m-self", "m-1", "m-2"]} size={20} />);
    const discs = container.firstElementChild!.children;
    expect((discs[0] as HTMLElement).style.marginLeft).toBe("0px");
    expect((discs[1] as HTMLElement).style.marginLeft).toBe("-1.5px");
  });
});

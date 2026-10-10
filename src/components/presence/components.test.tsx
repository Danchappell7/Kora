/* PresenceAvatars, TypingIndicator and RemoteCarets: what they show, what they say, and nothing when there's nobody. */
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresencePeer } from "../../data/types";
import { PresenceAvatars, presenceVerb } from "./PresenceAvatars";
import { FLAG_MS, RemoteCarets } from "./RemoteCarets";
import { TYPING_ANNOUNCE_AGAIN_MS, TypingIndicator } from "./TypingIndicator";

const peer = (userId: string, name: string, state: PresencePeer["state"] = "viewing", caret: PresencePeer["caret"] = null): PresencePeer =>
  ({ userId, name, color: "oklch(0.74 0.16 305)", state, caret, at: 0 });
const sana = peer("m-3", "Sana Rao"), theo = peer("m-2", "Theo Vance"), maya = peer("m-1", "Maya Lin"), idris = peer("m-4", "Idris Bell");

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00")); });
afterEach(() => { vi.useRealTimers(); });

describe("PresenceAvatars", () => {
  it("nothing when there's nobody", () => {
    const { container } = render(<PresenceAvatars peers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("one face per person, the sentence as its name and tooltip, a tab stop in a header", () => {
    render(<PresenceAvatars peers={[sana, theo]} />);
    const stack = screen.getByRole("img", { name: "Sana and Theo are viewing" });
    expect(stack).toHaveAttribute("data-tip", "Sana and Theo are viewing");
    expect(stack).toHaveAttribute("tabindex", "0");
    expect(stack.querySelectorAll(".kpres-face")).toHaveLength(2);
    expect(stack.textContent).toBe("SRTV");
  });
  it("up to max faces, then +n (the sentence still names them)", () => {
    render(<PresenceAvatars peers={[sana, theo, maya, idris]} max={2} />);
    const stack = screen.getByRole("img", { name: "Sana, Theo and 2 others are viewing" });
    expect(stack.querySelectorAll(".kpres-face")).toHaveLength(2);
    expect(stack.querySelector(".kpres-more")).toHaveTextContent("+2");
  });
  it("the row size is tiny and not a tab stop; a label overrides the sentence", () => {
    render(<PresenceAvatars peers={[sana]} size="xs" label="Sana has this task open" />);
    const stack = screen.getByRole("img", { name: "Sana has this task open" });
    expect(stack).not.toHaveAttribute("tabindex");
    expect(stack).toHaveAttribute("data-size", "xs");
  });
  it("the verb fits everyone", () => {
    expect(presenceVerb([peer("a", "A", "editing"), peer("b", "B", "typing")])).toBe("editing");
    expect(presenceVerb([peer("a", "A", "typing")])).toBe("typing");
    expect(presenceVerb([peer("a", "A", "editing"), peer("b", "B")])).toBe("viewing");
    render(<PresenceAvatars peers={[peer("a", "Ana Ruiz", "editing")]} />);
    expect(screen.getByRole("img", { name: "Ana is editing" })).toBeInTheDocument();
  });
});

describe("TypingIndicator", () => {
  it("nothing to see when nobody's typing, but the live region is there", () => {
    const { container } = render(<TypingIndicator typers={[]} />);
    expect(container.querySelector(".ktyping-vis")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
  it("shows and says it once per person, not per keystroke", () => {
    const { rerender, container } = render(<TypingIndicator typers={[{ ...theo, state: "typing" }]} />);
    const vis = () => container.querySelector(".ktyping-vis");
    expect(vis()).toHaveTextContent("Theo is typing…");
    expect(vis()).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Theo is typing…");
    // Sana joins in: only Sana is announced
    rerender(<TypingIndicator typers={[{ ...theo, state: "typing" }, { ...sana, state: "typing" }]} />);
    expect(vis()).toHaveTextContent("Theo and Sana are typing…");
    expect(screen.getByRole("status")).toHaveTextContent(/^Sana is typing…$/);
    // they stop and start again within the minute: not said again
    rerender(<TypingIndicator typers={[]} />);
    rerender(<TypingIndicator typers={[{ ...theo, state: "typing" }]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Sana is typing…$/);
    // a minute on: said again
    act(() => { vi.advanceTimersByTime(TYPING_ANNOUNCE_AGAIN_MS + 1); });
    rerender(<TypingIndicator typers={[]} />);
    rerender(<TypingIndicator typers={[{ ...theo, state: "typing" }]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Theo is typing…/);
  });
});

describe("RemoteCarets", () => {
  function setup(peers: PresencePeer[], edits: { blockId: string; by: PresencePeer; at: number }[] = []) {
    const root = createRef<HTMLDivElement>();
    const Host = ({ p, e }: { p: PresencePeer[]; e: typeof edits }) => (
      <div ref={root} style={{ position: "relative" }}>
        <div className="kdoc-text" data-b="b1">Hello there</div>
        <div className="kdoc-text" data-b="b2" />
        <RemoteCarets rootRef={root} peers={p} edits={e} layoutKey={0}
          locate={(id) => root.current?.querySelector<HTMLElement>(`[data-b="${id}"]`) ?? null} />
      </div>
    );
    const utils = render(<Host p={peers} e={edits} />);
    return { ...utils, rerender: (p: PresencePeer[], e = edits) => utils.rerender(<Host p={p} e={e} />) };
  }
  it("nothing without carets or edits", () => {
    const { container } = setup([sana]);
    expect(container.querySelector(".kpres-layer")).toBeNull();
  });
  it("a caret in the person's colour with their name while it moves, then just the caret", () => {
    const { container, rerender } = setup([peer("m-3", "Sana Rao", "editing", { blockId: "b1", offset: 5 })]);
    const caret = container.querySelector<HTMLElement>(".kpres-caret")!;
    expect(caret).toBeInTheDocument();
    expect(container.querySelector(".kpres-layer")).toHaveAttribute("aria-hidden", "true");
    expect(caret.querySelector(".kpres-flag")).toHaveTextContent("Sana");
    expect(caret).toHaveAttribute("data-recent");
    expect((caret.parentElement as HTMLElement).style.getPropertyValue("--kp-h")).toBe("305");
    act(() => { vi.advanceTimersByTime(FLAG_MS + 100); });
    rerender([peer("m-3", "Sana Rao", "editing", { blockId: "b1", offset: 5 })]);
    expect(container.querySelector(".kpres-caret")).not.toHaveAttribute("data-recent");
    // an empty block still gets a caret
    rerender([peer("m-3", "Sana Rao", "editing", { blockId: "b2", offset: 0 })]);
    expect(container.querySelector(".kpres-caret")).toHaveAttribute("data-recent");
  });
  it("a block someone just changed: a tinted box with their name, and the words say so to screen readers", () => {
    const { container, rerender } = setup([], [{ blockId: "b1", by: theo, at: 1 }]);
    expect(container.querySelector(".kpres-edit-tag")).toHaveTextContent("Theo");
    const text = container.querySelector('[data-b="b1"]')!;
    expect(text).toHaveAttribute("aria-description", "Edited by Theo Vance just now");
    rerender([], []);
    expect(text).not.toHaveAttribute("aria-description");
  });
  it("a caret in a block that isn't on screen is skipped", () => {
    const { container } = setup([peer("m-3", "Sana Rao", "editing", { blockId: "gone", offset: 2 })]);
    expect(container.querySelector(".kpres-caret")).toBeNull();
  });
});

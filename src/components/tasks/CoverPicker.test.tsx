/* TaskDetail › Cover: a radio group of the task's images (and "None"), saved
   at once on a click, a moment after arrowing stops; read-only for guests;
   the demo's seeded covers join in. The clock is pinned (fake timers). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CoverPicker, COVER_KEY_SAVE_MS } from "./CoverPicker";
import { getProject } from "../../data/data";
import type { Attachment } from "../../data/types";

const file = (id: string, mime = "image/png"): Attachment => ({ id, taskId: "x", name: `${id}.png`, size: 10, mime, path: `u/x/${id}`, url: `https://files.example/${id}.png`, createdAt: "2026-10-01T09:00:00Z" });
const files = [file("one"), file("two"), file("notes", "application/pdf")];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("CoverPicker", () => {
  it("offers None and the task's images (not other files), the saved one checked", () => {
    render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: "two" }} attachments={files} onChange={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: "Cover" });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["No cover", "one.png", "two.png"]);
    expect(screen.getByRole("radio", { name: "two.png" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "two.png" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "No cover" })).toHaveAttribute("tabindex", "-1");
    expect(group).toHaveAccessibleDescription(/Shown at the top of this task's card on the board/);
  });

  it("a click saves at once; None clears it", () => {
    const onChange = vi.fn();
    render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: null }} attachments={files} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "one.png" }));
    expect(onChange).toHaveBeenLastCalledWith("one");
    expect(screen.getByRole("status")).toHaveTextContent("Cover set to one.png.");
    cleanup();
    const clear = vi.fn();
    render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: "one" }} attachments={files} onChange={clear} />);
    fireEvent.click(screen.getByRole("radio", { name: "No cover" }));
    expect(clear).toHaveBeenCalledWith(null);
  });

  it("arrow keys move and choose, saving once after you stop", () => {
    const onChange = vi.fn();
    render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: null }} attachments={files} onChange={onChange} />);
    const none = screen.getByRole("radio", { name: "No cover" });
    none.focus();
    fireEvent.keyDown(none, { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("radio", { name: "one.png" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "two.png" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "two.png" })).toHaveAttribute("aria-checked", "true");
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(COVER_KEY_SAVE_MS); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("two");
    // Home wraps back to None; End to the last
    fireEvent.keyDown(screen.getByRole("radio", { name: "two.png" }), { key: "Home" });
    expect(none).toHaveFocus();
  });

  it("with the task panel saving each choice, the chosen cover stays chosen", () => {
    const saves: (string | null)[] = [];
    function Host() {
      const [cover, setCover] = useState<string | null>(null);
      return <CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: cover }} attachments={files} onChange={(c) => { saves.push(c); setCover(c); }} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("radio", { name: "one.png" }));
    expect(screen.getByRole("radio", { name: "one.png" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "one.png" }), { key: "ArrowRight" });
    act(() => { vi.advanceTimersByTime(COVER_KEY_SAVE_MS); });
    expect(screen.getByRole("radio", { name: "two.png" })).toHaveAttribute("aria-checked", "true");
    expect(saves).toEqual(["one", "two"]);
  });

  it("a choice still waiting is saved when the panel closes", () => {
    const onChange = vi.fn();
    const { unmount } = render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: null }} attachments={files} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "No cover" }), { key: "End" });
    unmount();
    expect(onChange).toHaveBeenCalledWith("two");
  });

  it("with no images: says how, and hands Upload to the host", () => {
    const onUpload = vi.fn();
    render(<CoverPicker task={{ id: "x", title: "Deck" }} attachments={[file("notes", "application/pdf")]} projectCovers onChange={vi.fn()} onUpload={onUpload} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText(/Add an image to this task to use it as the cover on its board card\. Until then, the project's cover shows\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload an image" }));
    expect(onUpload).toHaveBeenCalled();
  });

  it("with project covers on, the first choice is the project's cover", () => {
    render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: null }} attachments={files} projectCovers project={getProject("p-launch")} onChange={vi.fn()} />);
    const first = screen.getByRole("radio", { name: "Project cover" });
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(first.querySelector(".kpcover")).not.toBeNull();
  });

  it("guests see the cover, with nothing to change", () => {
    render(<CoverPicker task={{ id: "x", title: "Deck", coverAttachmentId: "one" }} attachments={files} readOnly onChange={vi.fn()} onUpload={vi.fn()} />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("one.png")).toBeInTheDocument();
    expect(document.querySelector(".kcov-static img")).toHaveAttribute("src", "https://files.example/one.png");
  });

  it("in the demo, a seeded task's images join in and its seeded cover is the choice", () => {
    render(<CoverPicker task={{ id: "t-1", title: "Finalise Q3 launch narrative deck" }} attachments={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "launch-deck-cover.svg" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "traction-chart.svg" })).toHaveAttribute("aria-checked", "false");
  });
});

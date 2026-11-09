/* The pieces every business shares: the mark, the row chip (only while All businesses is on), the
   switch and Today's lead line. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AllBusinessesToggle, BusinessChipsProvider, BusinessLeadLine, WorkspaceChip, WorkspaceMark } from "./Businesses";
import { WORKSPACES } from "../../data/data";
import type { BusinessLead } from "../../lib/businesses";
import type { Workspace } from "../../data/types";

describe("WorkspaceMark", () => {
  it("a logo when there is one, else the first letter on a tile of its own", () => {
    const { container, rerender } = render(<WorkspaceMark workspace={{ id: "w", name: "Acme", kind: "team", logoUrl: "https://x.io/l.png" }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://x.io/l.png");
    rerender(<WorkspaceMark workspace={{ id: "w", name: "Acme", kind: "team" }} title="Acme" />);
    expect(screen.getByRole("img", { name: "Acme" })).toHaveTextContent("A");
  });
});

describe("WorkspaceChip", () => {
  it("shows the business a row's task is from, only while All businesses is on", () => {
    const { rerender } = render(<BusinessChipsProvider on={false} workspaces={WORKSPACES}><WorkspaceChip projectId="p-clubhouse" /></BusinessChipsProvider>);
    expect(screen.queryByText("Courtside Padel")).toBeNull();
    rerender(<BusinessChipsProvider on workspaces={WORKSPACES}><WorkspaceChip projectId="p-clubhouse" /></BusinessChipsProvider>);
    expect(screen.getByTitle("Courtside Padel")).toHaveTextContent("In Courtside Padel");
    // a project you can't see (or none): nothing
    rerender(<BusinessChipsProvider on workspaces={WORKSPACES}><WorkspaceChip projectId="p-nowhere" /><WorkspaceChip /></BusinessChipsProvider>);
    expect(screen.queryByTitle(/./)).toBeNull();
  });
});

describe("AllBusinessesToggle", () => {
  it("a switch that says whether it's on", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AllBusinessesToggle on={false} onChange={onChange} />);
    const b = screen.getByRole("button", { name: "All businesses" });
    expect(b).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(b);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<AllBusinessesToggle on onChange={onChange} />);
    expect(screen.getByRole("button", { name: "All businesses" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("BusinessLeadLine", () => {
  const w = (id: string, name: string): Workspace => ({ id, name, kind: "team" });
  const lead: BusinessLead = {
    lead: { key: "w-b", workspace: w("w-b", "Beta Padel"), parts: ["sign the lighting order", "1 approval", "1 more overdue"], score: 9, taskId: "t-36" },
    others: [{ key: "w-a", workspace: w("w-a", "Alpha Studio"), parts: ["finalise the deck", "2 approvals", "3 more due today"], score: 6, taskId: "t-1" }],
    plain: "",
  };
  it("leads with the business that needs you most (its task opens), then the others", () => {
    const onOpen = vi.fn();
    render(<BusinessLeadLine lead={lead} onOpen={onOpen} />);
    const note = screen.getByRole("note", { name: "Across your businesses" });
    expect(note).toHaveTextContent("Beta Padel needs you most today: sign the lighting order, 1 approval and 1 more overdue.");
    expect(note).toHaveTextContent("Alpha Studio: finalise the deck, 2 approvals");
    fireEvent.click(screen.getByRole("button", { name: "sign the lighting order" }));
    expect(onOpen).toHaveBeenCalledWith("t-36");
  });
  it("nothing when no business needs you", () => {
    const { container } = render(<BusinessLeadLine lead={{ lead: null, others: [], plain: "" }} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

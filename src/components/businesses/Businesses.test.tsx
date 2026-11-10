/* The pieces every business shares: the mark, the row chip (only while All businesses is on), the
   switch and Today's lead line. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AllBusinessesToggle, BusinessChipsProvider, BusinessLeadLine, WorkspaceChip, WorkspaceMark, useGuestRow } from "./Businesses";
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
  // (logos, so a mark adds no letter to the text)
  const w = (id: string | null, name: string): Workspace => ({ id, name, kind: id ? "team" : "personal", logoUrl: "https://x.io/l.png" });
  const lead: BusinessLead = {
    lead: { key: "w-b", workspace: w("w-b", "Beta Padel"), parts: ["sign the lighting order", "1 approval", "1 more overdue"], score: 9, taskId: "t-36", taskWhen: "overdue", detail: "1 approval · 2 overdue" },
    others: [
      { key: "w-a", workspace: w("w-a", "Alpha Studio"), parts: ["finalise the deck", "2 approvals", "3 more due today"], score: 6, taskId: "t-1", taskWhen: "due today", detail: "2 approvals · 4 due today" },
      { key: "personal", workspace: w(null, "Personal"), parts: ["renew passport"], score: 2, taskId: "t-27", taskWhen: "due today", detail: "1 due today" },
    ],
    plain: "",
  };
  it("All businesses: one sentence for the business that needs you most (its task opens), the others on a quieter line", () => {
    const onOpen = vi.fn();
    render(<BusinessLeadLine lead={lead} onOpen={onOpen} />);
    const note = screen.getByRole("note", { name: "Across your workspaces" });
    expect(note).toHaveTextContent("Beta Padel needs you most today: sign the lighting order (overdue), 1 approval and 1 more overdue.");
    expect(note).toHaveTextContent("Then Alpha Studio · 2 approvals · 4 due today Personal · 1 due today");
    // Personal is called Personal, never a business
    expect(note).not.toHaveTextContent(/business/i);
    fireEvent.click(screen.getByRole("button", { name: "sign the lighting order" }));
    expect(onOpen).toHaveBeenCalledWith("t-36");
  });
  it("leaves out the task the brief's headline already names", () => {
    render(<BusinessLeadLine lead={lead} focusTaskId="t-36" onOpen={() => {}} />);
    expect(screen.getByRole("note")).toHaveTextContent("Beta Padel needs you most today: 1 approval and 1 more overdue.");
    expect(screen.queryByRole("button", { name: "sign the lighting order" })).toBeNull();
    // …and when that task is all it holds, only the others are named
    const only: BusinessLead = { ...lead, lead: { ...lead.lead!, parts: ["sign the lighting order"] } };
    const { container } = render(<BusinessLeadLine lead={only} focusTaskId="t-36" onOpen={() => {}} />);
    expect(container).toHaveTextContent("Needing you today: Alpha Studio");
    expect(container).not.toHaveTextContent("needs you most");
  });
  it("switched off: names the other workspace that needs you, and offers to show them all", () => {
    const onShowAll = vi.fn();
    render(<BusinessLeadLine lead={lead} mode="elsewhere" onOpen={() => {}} onShowAll={onShowAll} />);
    const note = screen.getByRole("note", { name: "Your other workspaces" });
    expect(note).toHaveTextContent("Beta Padel needs you: sign the lighting order (overdue), 1 approval and 1 more overdue. Alpha Studio and Personal need you too.");
    fireEvent.click(screen.getByRole("button", { name: "Show all businesses" }));
    expect(onShowAll).toHaveBeenCalled();
  });
  it("nothing when no business needs you", () => {
    const { container } = render(<BusinessLeadLine lead={{ lead: null, others: [], plain: "" }} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("useGuestRow", () => {
  function Probe({ ws }: { ws: string | null }) {
    const guestRow = useGuestRow();
    return <span>{guestRow({ workspaceId: ws }) ? "view only" : "editable"}</span>;
  }
  it("in All businesses a row from a workspace you're a guest in is view-only; off, the page decides", () => {
    const guestIn = new Set(["ws-harbour"]);
    const { rerender } = render(<BusinessChipsProvider on workspaces={WORKSPACES} guestIn={guestIn}><Probe ws="ws-harbour" /></BusinessChipsProvider>);
    expect(screen.getByText("view only")).toBeInTheDocument();
    rerender(<BusinessChipsProvider on workspaces={WORKSPACES} guestIn={guestIn}><Probe ws="ws-foundrise" /></BusinessChipsProvider>);
    expect(screen.getByText("editable")).toBeInTheDocument();
    rerender(<BusinessChipsProvider on workspaces={WORKSPACES} guestIn={guestIn}><Probe ws={null} /></BusinessChipsProvider>);
    expect(screen.getByText("editable")).toBeInTheDocument();
    rerender(<BusinessChipsProvider on={false} workspaces={WORKSPACES} guestIn={guestIn}><Probe ws="ws-harbour" /></BusinessChipsProvider>);
    expect(screen.getByText("editable")).toBeInTheDocument();
  });
});

/* FormsView › each form's public link (PublicLinkPanel, demo mode); Rules and Requests for a project
   you can only view (0058). */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AutomationsView, FormsView } from "./RulesForms";
import type { AutomationRule, FormDef, Project } from "../../data/types";
import * as data from "../../data/data";

const project: Project = { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.6 0.2 264)", workspaceId: "ws" };
const form: FormDef = { id: "33333333-3333-4333-8333-333333333333", projectId: "p-launch", workspaceId: "ws", name: "Launch requests", fields: ["description"] };

function forms(extra: Partial<Parameters<typeof FormsView>[0]> = {}) {
  const props: Parameters<typeof FormsView>[0] = {
    forms: [form], projects: [project], members: [],
    onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onSubmit: vi.fn(), onPublicChange: vi.fn(),
    ...extra,
  };
  render(<FormsView {...props} />);
  return props;
}

describe("FormsView › public link", () => {
  it("0058: a Members only or Private project's QR file isn't named after it (the public page doesn't name it either)", async () => {
    const saved = data.WORKSPACES;
    data.setReferenceData({ workspaces: [{ id: "ws", name: "Foundry", kind: "team", projectAccess: { on: true, defaultVisibility: "workspace", membersMayMakePrivate: false } }] });
    try {
      const clicks: HTMLAnchorElement[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
      // (an id the demo's own data doesn't have, so the card reads this project)
      const name = async (o: Partial<Project>) => {
        const p: Project = { ...project, id: "p-rf-closed", ...o };
        const { unmount } = render(<FormsView forms={[{ ...form, projectId: p.id, publicEnabled: true }]} projects={[p]} members={[]} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onSubmit={vi.fn()} onPublicChange={vi.fn()} />);
        fireEvent.click(await screen.findByRole("button", { name: "QR code" }));
        fireEvent.click(screen.getByRole("button", { name: "Download SVG" }));
        unmount();
        return clicks[clicks.length - 1].download;
      };
      expect(await name({ visibility: "private" })).toBe("launch-requests-qr.svg");
      expect(await name({ visibility: "members" })).toBe("launch-requests-qr.svg");
      expect(await name({ visibility: "workspace" })).toBe("q3-product-launch-launch-requests-qr.svg");
    } finally {
      data.setReferenceData({ workspaces: saved });
      vi.restoreAllMocks();
    }
  });

  it("each form card can switch on its public link, and the host hears about it", async () => {
    const props = forms();
    const card = screen.getByRole("article", { name: "Request form Launch requests" });
    fireEvent.click(within(card).getByRole("switch", { name: "Anyone with the link can submit" }));
    await waitFor(() => expect(props.onPublicChange).toHaveBeenCalledWith(form.id, { publicEnabled: true, publicToken: "demo" }));
  });

  it("guests can't switch it: they only see the link while it's on", () => {
    forms({ readOnly: true });
    const card = screen.getByRole("article", { name: "Request form Launch requests" });
    // link off: nothing for a guest at all
    expect(within(card).queryByRole("switch", { name: "Anyone with the link can submit" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /regenerate/i })).toBeNull();
  });
});

describe("Projects › Rules and Requests: a project you can only view (0058)", () => {
  const other: Project = { id: "p-ops", name: "Ops", emoji: "", color: "oklch(0.6 0.1 120)", workspaceId: "ws" };
  const rule: AutomationRule = { id: "r-1", workspaceId: "ws", projectId: "p-launch", name: "Triage", trigger: "task_created", actions: [{ type: "set_priority", value: "high" }], enabled: true };

  it("its rules read as a guest's: no pause, rename or delete; a new rule goes into a project you can change", () => {
    const onUpdate = vi.fn(), onCreate = vi.fn();
    render(<AutomationsView rules={[rule]} projects={[project, other]} members={[]} sections={[]} onCreate={onCreate} onUpdate={onUpdate} onDelete={vi.fn()} viewOnly={new Set(["p-launch"])} />);
    const card = screen.getByRole("article", { name: "Rule Triage" });
    expect(within(card).getByRole("switch", { name: "Run rule Triage" })).toBeDisabled();
    expect(within(card).queryByRole("button", { name: "Delete rule Triage" })).toBeNull();
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(card).getByRole("switch", { name: "Run rule Triage" }));
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    expect([...screen.getByRole("combobox", { name: "Project" }).querySelectorAll("option")].map((o) => o.value)).toEqual(["p-ops"]);
  });

  it("its forms can't be filled in, built or deleted here (filing needs edit rights), and the card says so", () => {
    forms({ projects: [project, other], viewOnly: new Set(["p-launch"]) });
    const card = screen.getByRole("article", { name: "Request form Launch requests" });
    expect(within(card).queryByRole("button", { name: "Open form Launch requests" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Delete form Launch requests" })).toBeNull();
    expect(within(card).getByText(/You can view Q3 Product Launch, but not file into it\./)).toBeInTheDocument();
    expect(within(card).queryByRole("switch", { name: "Anyone with the link can submit" })).toBeNull();
  });

  it("a form you can change still files, and a refused one keeps what was typed", () => {
    const onSubmit = vi.fn(() => false);
    forms({ onSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Open form Launch requests" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Fix the banner" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(onSubmit).toHaveBeenCalledWith("p-launch", expect.objectContaining({ title: "Fix the banner" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Fix the banner");
  });
});

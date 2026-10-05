/* FormsView › each form's public link (PublicLinkPanel, demo mode). */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FormsView } from "./RulesForms";
import type { FormDef, Project } from "../../data/types";

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

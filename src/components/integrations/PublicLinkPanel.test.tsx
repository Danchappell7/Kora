/* PublicLinkPanel: the demo (tests run without Supabase, so the real
   lib/publicForms is in demo mode), then the signed-in behaviours with
   lib/publicForms' calls stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FormDef } from "../../data/types";

const lib = vi.hoisted(() => ({
  on: false,
  status: null as null | { links: string; page: string },
  setFormPublic: null as null | ((id: string, enabled: boolean) => Promise<unknown>),
  regenerate: null as null | ((id: string) => Promise<string>),
}));
vi.mock("../../lib/publicForms", async (orig) => {
  const real = await orig<typeof import("../../lib/publicForms")>();
  return {
    ...real,
    publicLinksStatus: (o?: object) => (lib.on && lib.status ? Promise.resolve(lib.status) : real.publicLinksStatus(o)),
    setFormPublic: (id: string, en: boolean) => (lib.on && lib.setFormPublic ? lib.setFormPublic(id, en) : real.setFormPublic(id, en)),
    regenerateFormLink: (id: string) => (lib.on && lib.regenerate ? lib.regenerate(id) : real.regenerateFormLink(id)),
  };
});

import { PublicLinkPanel, qrFileName } from "./PublicLinkPanel";
import { PublicLinkError } from "../../lib/publicForms";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NEW_TOKEN = "fedcba9876543210fedcba9876543210";
const base: FormDef = { id: "33333333-3333-4333-8333-333333333333", projectId: "p-launch", workspaceId: "ws", name: "Launch requests", fields: ["description"] };

beforeEach(() => { lib.on = false; lib.status = null; lib.setFormPublic = null; lib.regenerate = null; });
afterEach(() => { vi.restoreAllMocks(); });

const live = (status = { links: "ready", page: "live" }) => { lib.on = true; lib.status = status; };
const toggle = () => screen.getByRole("switch", { name: "Anyone with the link can submit" });

describe("in the demo", () => {
  it("switches on locally, links to /f/demo, and tells the host", async () => {
    const onChange = vi.fn();
    render(<PublicLinkPanel form={base} canEdit projectName="Q3 Product Launch" onChange={onChange} />);
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(toggle());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ publicEnabled: true, publicToken: "demo" }));
    const field = await screen.findByLabelText("Public link to Launch requests");
    expect(field).toHaveValue(`${window.location.origin}/f/demo`);
    expect(field).toHaveAttribute("readonly");
    expect(screen.getByRole("link", { name: /open the form/i })).toHaveAttribute("href", `${window.location.origin}/f/demo`);
    expect(screen.getByRole("link", { name: /open the form/i })).toHaveAttribute("target", "_blank");
    // one example page for every demo form: nothing to regenerate
    expect(screen.queryByRole("button", { name: /regenerate/i })).toBeNull();
    expect(screen.getByText(/every form opens the same example page/)).toBeInTheDocument();
  });
  it("copies the link", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PublicLinkPanel form={{ ...base, publicEnabled: true }} canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/f/demo`));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
  it("shows a scannable QR code (dark on white) and downloads it as SVG", async () => {
    render(<PublicLinkPanel form={{ ...base, publicEnabled: true }} canEdit projectName="Q3 Product Launch" />);
    const qrBtn = await screen.findByRole("button", { name: "QR code" });
    expect(qrBtn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(qrBtn);
    expect(qrBtn).toHaveAttribute("aria-expanded", "true");
    const img = screen.getByRole("img", { name: "QR code that opens the Launch requests form" });
    expect(img.querySelector("rect")).toHaveAttribute("fill", "#FFFFFF");
    expect(img.querySelector("path")).toHaveAttribute("fill", "#0B1020");
    expect(img.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
    fireEvent.click(screen.getByRole("button", { name: "Download SVG" }));
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe("q3-product-launch-launch-requests-qr.svg");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
  it("names the download safely", () => {
    expect(qrFileName("Café / IT desk!", "Ops & Facilities")).toBe("ops-facilities-cafe-it-desk-qr.svg");
    expect(qrFileName("Bugs")).toBe("bugs-qr.svg");
  });
});

describe("people who can't edit the form (guests)", () => {
  it("see nothing while the link is off", async () => {
    const { container } = render(<PublicLinkPanel form={base} canEdit={false} />);
    expect(container).toBeEmptyDOMElement();
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
  it("see and copy the link while it's on, but can't switch it or make a new one", async () => {
    live();
    render(<PublicLinkPanel form={{ ...base, publicEnabled: true, publicToken: TOKEN }} canEdit={false} />);
    expect(await screen.findByLabelText("Public link to Launch requests")).toHaveValue(`${window.location.origin}/f/${TOKEN}`);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /regenerate/i })).toBeNull();
    expect(screen.getByText(/Only members can switch this link off/)).toBeInTheDocument();
  });
});

describe("signed in", () => {
  it("switching on shows the server's link; off says the same link comes back", async () => {
    live();
    lib.setFormPublic = vi.fn(async (_id: string, en: boolean) => ({ publicEnabled: en, publicToken: TOKEN }));
    const onChange = vi.fn();
    render(<PublicLinkPanel form={base} canEdit onChange={onChange} />);
    fireEvent.click(toggle());
    expect(await screen.findByLabelText("Public link to Launch requests")).toHaveValue(`${window.location.origin}/f/${TOKEN}`);
    expect(onChange).toHaveBeenLastCalledWith({ publicEnabled: true, publicToken: TOKEN });
    fireEvent.click(toggle());
    expect(await screen.findByText(/Switching it back on brings back the same link/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Public link to Launch requests")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ publicEnabled: false, publicToken: TOKEN });
  });
  it("a refusal puts the switch back and says why", async () => {
    live();
    lib.setFormPublic = vi.fn(async () => { throw new PublicLinkError("forbidden", "You can't change this form's link. Ask someone who can edit the form."); });
    const onChange = vi.fn();
    render(<PublicLinkPanel form={base} canEdit onChange={onChange} />);
    fireEvent.click(toggle());
    expect(await screen.findByRole("alert")).toHaveTextContent("You can't change this form's link");
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("regenerate: confirm first (focus on Cancel, Escape backs out), then a new link", async () => {
    live();
    lib.regenerate = vi.fn(async () => NEW_TOKEN);
    const onChange = vi.fn();
    render(<PublicLinkPanel form={{ ...base, publicEnabled: true, publicToken: TOKEN }} canEdit onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate link" }));
    const group = screen.getByRole("group", { name: "Regenerate the link?" });
    expect(group).toHaveAccessibleDescription(/stop working straight away/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(group, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Regenerate the link?" })).toBeNull();
    expect(lib.regenerate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate link" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Regenerate link" }));
    const confirm = screen.getAllByRole("button", { name: "Regenerate link" }).find((b) => b.getAttribute("data-variant") === "danger")!;
    await act(async () => { fireEvent.click(confirm); });
    expect(lib.regenerate).toHaveBeenCalledWith(base.id);
    expect(screen.getByLabelText("Public link to Launch requests")).toHaveValue(`${window.location.origin}/f/${NEW_TOKEN}`);
    expect(onChange).toHaveBeenCalledWith({ publicEnabled: true, publicToken: NEW_TOKEN });
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus());
  });
  it("before 0043: editors are told it isn't switched on yet; guests see nothing", async () => {
    live({ links: "unavailable", page: "unknown" });
    const { unmount } = render(<PublicLinkPanel form={base} canEdit />);
    expect(await screen.findByText(/Public links aren't switched on for Kanbo yet/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    unmount();
    const { container } = render(<PublicLinkPanel form={{ ...base, publicEnabled: true, publicToken: TOKEN }} canEdit={false} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
  it("a switch that finds 0043 missing turns into that explanation", async () => {
    live({ links: "ready", page: "unknown" });
    lib.setFormPublic = vi.fn(async () => { throw new PublicLinkError("unavailable", "x"); });
    render(<PublicLinkPanel form={base} canEdit />);
    fireEvent.click(toggle());
    expect(await screen.findByText(/aren't switched on for Kanbo yet/)).toBeInTheDocument();
  });
  it("says when the public page isn't live yet", async () => {
    live({ links: "ready", page: "missing" });
    render(<PublicLinkPanel form={{ ...base, publicEnabled: true, publicToken: TOKEN }} canEdit />);
    expect(await screen.findByText(/The public page isn't live yet/)).toBeInTheDocument();
  });
  it("a form that's still saving can't be switched yet", async () => {
    live();
    render(<PublicLinkPanel form={{ ...base, id: "tmp-form-1" }} canEdit />);
    await act(async () => {});
    expect(toggle()).toBeDisabled();
    expect(screen.getByText(/once the form has finished saving/)).toBeInTheDocument();
  });
  it("follows the host when the form changes elsewhere", async () => {
    live();
    const { rerender } = render(<PublicLinkPanel form={base} canEdit />);
    rerender(<PublicLinkPanel form={{ ...base, publicEnabled: true, publicToken: TOKEN }} canEdit />);
    expect(await screen.findByLabelText("Public link to Launch requests")).toHaveValue(`${window.location.origin}/f/${TOKEN}`);
    expect(toggle()).toHaveAttribute("aria-checked", "true");
  });
});

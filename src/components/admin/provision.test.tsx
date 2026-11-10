/* /admin › Provision a business and Adoption by workspace (0058), in the demo: the form's checks (a public
   mail domain is never offered for approval), the steps as they go (workspace, pack, the owner's invite,
   the domain, the handover) and the new business's row in the adoption table. */
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProvisionBusiness, companyDomainOf } from "./ProvisionBusiness";
import { AdoptionPanel } from "./AdoptionPanel";
import { store } from "../../data/store";

const ME = { id: "m-self", email: "daniel@kanbo.app", name: "Daniel Okai" };
const field = (name: string) => screen.getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement;

describe("Provision a business", () => {
  it("fills the company domain in from the owner's address, never a public mail provider's", () => {
    expect(companyDomainOf("nina@HarbourFit.co.uk")).toBe("harbourfit.co.uk");
    expect(companyDomainOf("nina@gmail.com")).toBe("");
    expect(companyDomainOf("nope")).toBe("");
    render(<ProvisionBusiness me={ME} />);
    const go = screen.getByRole("button", { name: "Provision" });
    expect(go).toBeDisabled();
    fireEvent.change(field("Business name"), { target: { value: "Harbour Fitness" } });
    fireEvent.change(field("Owner's email"), { target: { value: "nina@harbourfit.co.uk" } });
    expect(field("Company domain")).toHaveValue("harbourfit.co.uk");
    expect(screen.getByText(/Anyone signing up with an @harbourfit.co.uk address gets in without waiting/)).toBeInTheDocument();
    expect(go).toBeEnabled();
    fireEvent.change(field("Company domain"), { target: { value: "gmail.com" } });
    expect(screen.getByText("@gmail.com is a public email provider: approving it would let anyone in.")).toBeInTheDocument();
    expect(go).toBeDisabled();
    fireEvent.change(field("Company domain"), { target: { value: "" } });
    expect(screen.getByText(/Without a domain/)).toBeInTheDocument();
    expect(go).toBeEnabled();
    fireEvent.change(field("Owner's email"), { target: { value: "not an email" } });
    expect(screen.getByText("That doesn't look like an email address.")).toBeInTheDocument();
    expect(go).toBeDisabled();
  });
  it("sets it all up and says how each step went; the new business joins the adoption table", async () => {
    let provisioned = 0;
    const { rerender } = render(<><ProvisionBusiness me={ME} onProvisioned={() => { provisioned++; }} /><AdoptionPanel refreshKey={provisioned} /></>);
    fireEvent.change(field("Business name"), { target: { value: "Harbour Fitness" } });
    fireEvent.change(screen.getByLabelText("Business pack"), { target: { value: "pack-fitness" } });
    fireEvent.change(field("Owner's email"), { target: { value: "nina@harbourfit.co.uk" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Provision" })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Provision another" })).toBeInTheDocument(), { timeout: 8000 });
    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "waiting"]);
    expect(steps[0]).toHaveTextContent("Make Harbour Fitness");
    expect(steps[1]).toHaveTextContent(/Set up the Boutique fitness group pack5 projects, 9 goals, 34 tasks/);
    expect(steps[2]).toHaveTextContent("Invite nina@harbourfit.co.uk as the owner");
    expect(steps[3]).toHaveTextContent("Approve @harbourfit.co.uk sign-ups");
    expect(steps[4]).toHaveTextContent(/When they join, they're the owner and what was set up is theirs/);
    expect(provisioned).toBe(1);
    // in the demo store: the workspace, and the owner-to-be invited as an admin until they join
    const b = await store.bootstrap({ id: "m-self" });
    const ws = b.workspaces.find((w) => w.name === "Harbour Fitness")!;
    expect(b.members.find((m) => m.workspaceId === ws.id && m.status === "invited")).toMatchObject({ email: "nina@harbourfit.co.uk", role: "admin" });
    rerender(<><ProvisionBusiness me={ME} onProvisioned={() => { provisioned++; }} /><AdoptionPanel refreshKey={provisioned} /></>);
    expect(await screen.findByText("Waiting for nina@harbourfit.co.uk to join")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Provision another" }));
    expect(field("Business name")).toHaveValue("");
  });
});

describe("Adoption by workspace", () => {
  it("weekly actives per workspace, the quietest first (or the most active)", async () => {
    render(<AdoptionPanel />);
    const table = await screen.findByRole("table");
    const names = () => within(table).getAllByRole("rowheader").map((r) => r.querySelector(".kadp-name")?.textContent);
    expect(names().slice(0, 2)).toEqual(["Harbour Advisory", "Northlight Studio"]);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Most active" }));
    expect(names()[0]).toBe("Courtside Padel");
    expect(screen.getByText(/people active this week/)).toBeInTheDocument();
  });
});

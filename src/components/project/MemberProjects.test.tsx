/* A person's projects in their Team profile (0058): what they're on and their role there, or what a
   pending invite brings; changed, taken off and added to right there; a guest comments at most. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemberProjects } from "./MemberProjects";

const rows = [{ projectId: "p-brand", name: "Brand Refresh", role: "commenter" as const }, { projectId: "p-own", name: "Their own", role: "owner" as const }];
const addable = [{ id: "p-seed", name: "Seed round" }];

describe("MemberProjects", () => {
  it("a guest: the projects they see, each role changed or taken off, and Add to a project (as a commenter)", async () => {
    const onSet = vi.fn(async () => true), onRemove = vi.fn(async () => true);
    render(<MemberProjects name="Ana Ruiz" guest pending={false} rows={rows} addable={addable} onSet={onSet} onRemove={onRemove} />);
    const sec = screen.getByRole("region", { name: "Projects" });
    expect(within(sec).getByText("Ana sees only these projects here.")).toBeInTheDocument();
    // (a guest who owns a project, made a guest after making it, keeps it as a commenter)
    expect(within(sec).getByText("Owner · can comment")).toBeInTheDocument();
    const role = within(sec).getByRole("combobox", { name: "Ana's role on Brand Refresh" });
    expect([...role.querySelectorAll("option")].map((o) => o.value)).toEqual(["commenter", "viewer"]);
    fireEvent.change(role, { target: { value: "viewer" } });
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledWith("p-brand", "viewer"));
    await vi.waitFor(() => expect(within(sec).getByRole("button", { name: "Take Ana off Brand Refresh" })).not.toBeDisabled());
    fireEvent.click(within(sec).getByRole("button", { name: "Take Ana off Brand Refresh" }));
    await vi.waitFor(() => expect(onRemove).toHaveBeenCalledWith("p-brand"));
    await vi.waitFor(() => expect(within(sec).getByRole("combobox", { name: "Add Ana to a project" })).not.toBeDisabled());
    fireEvent.change(within(sec).getByRole("combobox", { name: "Add Ana to a project" }), { target: { value: "p-seed" } });
    fireEvent.click(within(sec).getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(onSet).toHaveBeenCalledWith("p-seed", "commenter"));
    expect(within(sec).getByText("Guests can comment at most.")).toBeInTheDocument();
  });

  it("a pending invite: the projects it brings once they join; a member is told they see every Whole workspace project too", () => {
    const { rerender } = render(<MemberProjects name="jo@acme.co" guest pending rows={[rows[0]]} addable={[]} onSet={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("jo@acme.co will see this project once they join.")).toBeInTheDocument();
    rerender(<MemberProjects name="Theo Vance" guest={false} pending={false} rows={[]} addable={addable} onSet={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Theo also sees every Whole workspace project.")).toBeInTheDocument();
    expect([...screen.getByRole("combobox", { name: "Add Theo to a project" }).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Add to a project…", "Seed round"]);
  });
  it("0058: an admin (who may not see every Private project) is told the list is of the projects they can see", () => {
    const { rerender } = render(<MemberProjects name="Ana Ruiz" guest pending={false} partial rows={[rows[0]]} addable={[]} onSet={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Ana sees only this project of the ones you can see here. Private projects you're not on aren't listed.")).toBeInTheDocument();
    rerender(<MemberProjects name="jo@acme.co" guest pending partial rows={[]} addable={[]} onSet={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("jo@acme.co will see no projects of the ones you can see here until you add them to one. Private projects you're not on aren't listed.")).toBeInTheDocument();
  });
});

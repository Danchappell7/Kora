import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WelcomeModal } from "./WelcomeModal";
import { OnboardingModal } from "./OnboardingModal";
import type { Profile } from "../data/types";

const profile = (firstName: string): Profile => ({ id: "u1", firstName, lastName: "", pronouns: "", email: "sam@company.com", avatarUrl: null });

describe("WelcomeModal", () => {
  it("does not dismiss (and so never persists) on Escape while the name is still empty", () => {
    const onClose = vi.fn();
    render(<WelcomeModal open onClose={onClose} onSaveProfile={vi.fn(async () => {})} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add your first name");
  });

  it("stays on the tour when the saved name flows back in as a new profile", async () => {
    const save = vi.fn(async () => {});
    const { rerender } = render(<WelcomeModal open onClose={() => {}} initialFirst="" onSaveProfile={save} />);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("heading", { name: /You're all set, Sam/ })).toBeInTheDocument();
    // App's saveProfile updates the profile, so the modal's initial name changes
    rerender(<WelcomeModal open onClose={() => {}} initialFirst="Sam" onSaveProfile={save} />);
    expect(screen.getByRole("heading", { name: /You're all set, Sam/ })).toBeInTheDocument();
  });

  it("fills in a name that loads after the modal opens", () => {
    const { rerender } = render(<WelcomeModal open onClose={() => {}} onSaveProfile={vi.fn(async () => {})} />);
    rerender(<WelcomeModal open onClose={() => {}} initialFirst="Priya" onSaveProfile={vi.fn(async () => {})} />);
    expect(screen.getByLabelText("First name")).toHaveValue("Priya");
  });

  it("asks for a first name and last name, with no borrowed example names", () => {
    render(<WelcomeModal open onClose={() => {}} onSaveProfile={vi.fn(async () => {})} />);
    expect(screen.getByLabelText("First name")).toHaveAttribute("placeholder", "First name");
    expect(screen.getByLabelText("Last name")).toHaveAttribute("placeholder", "Last name");
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  it("lets Escape close once a name exists", () => {
    const onClose = vi.fn();
    render(<WelcomeModal open canSkip initialFirst="Sam" onClose={onClose} onSaveProfile={vi.fn(async () => {})} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("OnboardingModal", () => {
  const base = { open: true, workspaceId: null, onSaveProfile: vi.fn(async () => {}), onCreateProject: vi.fn(), onFinish: vi.fn() };

  it("skips the name step when the profile already has a first name", () => {
    render(<OnboardingModal {...base} profile={profile("Sam")} />);
    expect(screen.getByRole("heading", { name: "Welcome, Sam" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    expect(screen.getByRole("heading", { name: "Create your first project" })).toBeInTheDocument();
  });

  it("syncs the name fields from a profile that arrives after mount", () => {
    const { rerender } = render(<OnboardingModal {...base} profile={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    expect(screen.getByLabelText("First name")).toHaveValue("");
    rerender(<OnboardingModal {...base} profile={{ ...profile(""), lastName: "Okafor" }} />);
    expect(screen.getByLabelText("Last name")).toHaveValue("Okafor");
  });

  it("takes focus back when the welcome modal on top of it closes", () => {
    const onFinish = vi.fn();
    const Both = ({ welcome }: { welcome: boolean }) => (
      <>
        <OnboardingModal {...base} onFinish={onFinish} profile={profile("Sam")} />
        <WelcomeModal open={welcome} canSkip initialFirst="Sam" onClose={() => {}} onSaveProfile={vi.fn(async () => {})} />
      </>
    );
    const { rerender } = render(<Both welcome />);
    expect(screen.getByLabelText("First name")).toHaveFocus();
    rerender(<Both welcome={false} />);
    expect(screen.getByRole("button", { name: /Get started/ })).toHaveFocus();

    // and if focus is ever dropped onto the page behind, keys still reach it
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onFinish = vi.fn();
    render(<OnboardingModal {...base} onFinish={onFinish} profile={null} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onFinish).toHaveBeenCalled();
  });

  it("creates the first project with the colour picked from the radio group", () => {
    const onCreateProject = vi.fn();
    render(<OnboardingModal {...base} onCreateProject={onCreateProject} workspaceId="w1" profile={profile("Sam")} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Website redesign" } });
    const colours = screen.getByRole("radiogroup", { name: "Project colour" });
    expect(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
    fireEvent.keyDown(colours, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Violet" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Violet" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
    expect(onCreateProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Website redesign", color: "oklch(0.74 0.16 305)", workspaceId: "w1" }));
    expect(screen.getByRole("heading", { name: "Your five places" })).toBeInTheDocument();
  });

  it("ends on your five places, then takes you to Today", () => {
    const onFinish = vi.fn();
    const onGoToday = vi.fn();
    render(<OnboardingModal {...base} onFinish={onFinish} onGoToday={onGoToday} profile={profile("Sam")} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "Your five places" })).toBeInTheDocument();
    expect(screen.getByText(/You're all set, Sam/)).toBeInTheDocument();
    const places = screen.getAllByRole("listitem");
    expect(places.map((li) => li.querySelector(".konb-place-name")?.textContent)).toEqual(["Today", "Inbox", "My tasks", "Projects", "Team"]);
    expect(screen.getByText("Your plan for the day, drawn for you.")).toBeInTheDocument();
    expect(screen.getByText("Mentions, assignments and requests.")).toBeInTheDocument();
    expect(screen.getByText("Everything on your plate, and what you're waiting on.")).toBeInTheDocument();
    expect(screen.getByText("Your team's projects, goals and requests.")).toBeInTheDocument();
    expect(screen.getByText("Who's doing what, and what's at risk.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Step 3 of 3: Your five places");
    const go = screen.getByRole("button", { name: /Take me to Today/ });
    expect(go).toHaveFocus();
    fireEvent.click(go);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onGoToday).toHaveBeenCalledTimes(1);
  });
});

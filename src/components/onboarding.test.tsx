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
    expect(screen.getByLabelText("Surname")).toHaveValue("Okafor");
  });

  it("closes on Escape", () => {
    const onFinish = vi.fn();
    render(<OnboardingModal {...base} onFinish={onFinish} profile={null} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onFinish).toHaveBeenCalled();
  });
});

import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WelcomeModal } from "./WelcomeModal";
import { OnboardingModal } from "./OnboardingModal";
import { __resetTourBus, onTourDecline, onTourRequest, tourWanted } from "../lib/onboarding";
import type { Profile } from "../data/types";

beforeEach(() => { __resetTourBus(); });

const profile = (firstName: string): Profile => ({ id: "u1", firstName, lastName: "", pronouns: "", email: "sam@company.com", avatarUrl: null });

describe("WelcomeModal", () => {
  it("does not dismiss (and so never persists) on Escape while the name is still empty", () => {
    const onClose = vi.fn();
    render(<WelcomeModal open onClose={onClose} onSaveProfile={vi.fn(async () => {})} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add your first name");
  });

  it("closes once the name is saved: it doesn't describe the app (the tour shows the real thing)", async () => {
    const save = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<WelcomeModal open onClose={onClose} initialFirst="" onSaveProfile={save} />);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("Sam", "");
    expect(screen.queryByText(/rhythm/)).toBeNull();
  });

  it("offerTour: ends on the hand-over, which stays put when the saved name flows back in", async () => {
    const save = vi.fn(async () => {});
    const onClose = vi.fn(), onStartTour = vi.fn(), onSkipTour = vi.fn();
    const { rerender } = render(<WelcomeModal open offerTour onClose={onClose} initialFirst="" onSaveProfile={save} onStartTour={onStartTour} onSkipTour={onSkipTour} />);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("heading", { name: /You're all set, Sam/ })).toBeInTheDocument();
    // App's saveProfile updates the profile, so the modal's initial name changes
    rerender(<WelcomeModal open offerTour onClose={onClose} initialFirst="Sam" onSaveProfile={save} onStartTour={onStartTour} onSkipTour={onSkipTour} />);
    expect(screen.getByRole("heading", { name: /You're all set, Sam/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 2: You're all set");
    expect(screen.getByRole("button", { name: /Show me around/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Show me around/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStartTour).toHaveBeenCalledTimes(1);
    expect(onSkipTour).not.toHaveBeenCalled();
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
    expect(screen.getByRole("heading", { name: "You're all set, Sam" })).toBeInTheDocument();
  });

  it("ends on the hand-over to the tour: Show me around starts it, and you land on Today", () => {
    const onFinish = vi.fn(), onGoToday = vi.fn(), onStartTour = vi.fn(), onSkipTour = vi.fn();
    render(<OnboardingModal {...base} onFinish={onFinish} onGoToday={onGoToday} onStartTour={onStartTour} onSkipTour={onSkipTour} profile={profile("Sam")} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "You're all set, Sam" })).toBeInTheDocument();
    // no list of places: the tour points at the real ones
    expect(screen.queryByText("Your plan for the day, drawn for you.")).toBeNull();
    expect(screen.getByText(/about three minutes/)).toBeInTheDocument();
    expect(screen.getByText(/any time from Help/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Step 3 of 3: You're all set");
    const go = screen.getByRole("button", { name: /Show me around/ });
    expect(go).toHaveFocus();
    fireEvent.click(go);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onGoToday).toHaveBeenCalledTimes(1);
    expect(onStartTour).toHaveBeenCalledTimes(1);
    expect(onSkipTour).not.toHaveBeenCalled();
  });

  it("Skip the tour: recorded through lib/onboarding (declineTour) when the host doesn't handle it", async () => {
    const onFinish = vi.fn(), onGoToday = vi.fn(), declined = vi.fn(), started = vi.fn();
    render(<OnboardingModal {...base} onFinish={onFinish} onGoToday={onGoToday} profile={profile("Sam")} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip the tour" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onGoToday).toHaveBeenCalledTimes(1);
    expect(tourWanted()).toBe(true); // the host mounts its (lazy) TourHost, which hears it
    onTourRequest(started);
    onTourDecline(declined);
    await Promise.resolve();
    expect(declined).toHaveBeenCalledWith({ from: "onboarding" });
    expect(started).not.toHaveBeenCalled();
  });

  it("Show me around, by default, asks the TourHost through lib/onboarding (startTour)", async () => {
    render(<OnboardingModal {...base} profile={profile("Sam")} />);
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: /Show me around/ }));
    const started = vi.fn();
    onTourRequest(started);
    await Promise.resolve();
    expect(started).toHaveBeenCalledWith({ from: "onboarding" });
  });
});

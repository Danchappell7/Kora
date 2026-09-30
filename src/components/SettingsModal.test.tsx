import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { AuthProvider } from "../auth/AuthProvider";

function renderSettings(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props: Parameters<typeof SettingsModal>[0] = {
    open: true,
    onClose: vi.fn(),
    initial: { firstName: "Ada", lastName: "Lovelace", pronouns: "", avatarUrl: null },
    email: "ada@acme.co.uk",
    color: "oklch(0.6 0.2 264)",
    onUpload: vi.fn(async () => "blob:demo"),
    onSave: vi.fn(async () => {}),
    onExport: vi.fn(),
    onDeleteAccount: vi.fn(async () => {}),
    ...overrides,
  };
  render(<AuthProvider><SettingsModal {...props} /></AuthProvider>);
  return props;
}

describe("Settings → Password & sign-in", () => {
  it("checks length and confirmation before changing the password", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    const pw = await screen.findByLabelText("New password");
    await waitFor(() => expect(pw).toHaveFocus());
    const confirm = screen.getByLabelText("Confirm new password");

    fireEvent.change(pw, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(pw).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText(/password updated/i)).not.toBeInTheDocument();

    fireEvent.change(pw, { target: { value: "correct horse battery" } });
    fireEvent.change(confirm, { target: { value: "correct horse battery!" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(screen.getByText("The two passwords don't match.")).toBeInTheDocument();

    fireEvent.change(confirm, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    await waitFor(() => expect(screen.getByText(/password updated/i)).toBeInTheDocument());
  });

  it("says so when the confirmation is left empty", async () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));
    const pw = await screen.findByLabelText("New password");
    const confirm = screen.getByLabelText("Confirm new password");
    fireEvent.change(pw, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: /update password/i }));
    expect(screen.getByText("Type your new password again to confirm it.")).toBeInTheDocument();
    expect(confirm).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(screen.queryByText(/password updated/i)).not.toBeInTheDocument();
  });

  it("doesn't offer signing out of every device in demo mode (there are no sessions)", () => {
    renderSettings();
    expect(screen.queryByRole("button", { name: /sign out everywhere/i })).not.toBeInTheDocument();
  });
});

describe("Settings → Delete account", () => {
  it("explains what happens to personal and team work, and needs DELETE typed", async () => {
    const props = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    expect(screen.getByText(/your profile, your profile photo, and your personal tasks and projects/i)).toBeInTheDocument();
    expect(screen.getByText(/stay where they are/i)).toBeInTheDocument();
    expect(screen.getByText(/still showing your name/i)).toBeInTheDocument();
    expect(screen.getByText(/pass to their next admin/i)).toBeInTheDocument();

    const forever = screen.getByRole("button", { name: /delete forever/i });
    expect(forever).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), { target: { value: "delete" } });
    expect(forever).toBeEnabled();
    fireEvent.click(forever);
    await waitFor(() => expect(props.onDeleteAccount).toHaveBeenCalledTimes(1));
  });

  it("shows a failed deletion inside the confirmation panel", async () => {
    renderSettings({ onDeleteAccount: vi.fn(async () => { throw new Error("Couldn't delete account (500)"); }) });
    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
    fireEvent.change(screen.getByLabelText(/type delete to confirm/i), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /delete forever/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't delete account (500)");
  });
});

describe("Settings → profile photo", () => {
  it("offers only the allowed image types and refuses an SVG with a clear reason", async () => {
    const props = renderSettings();
    const input = screen.getByLabelText("Upload profile photo") as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/SVG images can't be used/);
    expect(props.onUpload).not.toHaveBeenCalled();
  });

  it("uploads a GIF under an extension taken from its type", async () => {
    const props = renderSettings();
    const input = screen.getByLabelText("Upload profile photo");
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(64)], "funny.php", { type: "image/gif" })] } });
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    const sent = (props.onUpload as ReturnType<typeof vi.fn>).mock.calls[0][0] as File;
    expect(sent.name).toBe("avatar.gif");
    expect(sent.type).toBe("image/gif");
  });
});

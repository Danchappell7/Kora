import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  getProfile: vi.fn(),
}));
vi.mock("./AuthProvider", () => ({ useAuth: () => h.auth }));
vi.mock("../data/store", () => ({ store: { getProfile: h.getProfile, createAccessRequest: vi.fn() } }));

import { LoginScreen, UpdatePasswordScreen, PendingApproval } from "./LoginScreen";

function mockAuth(over: Record<string, unknown> = {}) {
  h.auth = {
    configured: true, loading: false, recovery: false, pendingLink: null, passwordReason: null, linkError: null,
    user: { id: "u1", email: "sam@company.com" },
    clearLinkError: vi.fn(), verifyLink: vi.fn(async () => ({})),
    signIn: vi.fn(async () => ({})), signUp: vi.fn(async () => ({})), resendConfirmation: vi.fn(async () => ({})),
    signInWithGoogle: vi.fn(async () => ({})), resetPassword: vi.fn(async () => ({})),
    updatePassword: vi.fn(async () => ({})), signOut: vi.fn(async () => {}),
    ...over,
  };
  return h.auth as Record<string, ReturnType<typeof vi.fn>>;
}

describe("LoginScreen", () => {
  beforeEach(() => { mockAuth(); });

  it("tells a new user to confirm their email when sign-up returns no session", async () => {
    const a = mockAuth({ signUp: vi.fn(async () => ({ needsConfirmation: true })) });
    render(<LoginScreen initialMode="signup" />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@company.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long enough pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Check your inbox to confirm your email, then sign in.")).toBeInTheDocument();
    expect(a.signUp).toHaveBeenCalledWith("new@company.com", "long enough pw");
    expect(screen.queryByText(/signing you in/)).not.toBeInTheDocument();
    // it's now the sign-in form, with a resend option
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send it again/ })).toBeInTheDocument();
  });

  it("opens reset mode with an explanation after an expired link", () => {
    const a = mockAuth({ linkError: { kind: "expired", message: "That link has expired — send yourself a new one." } });
    render(<LoginScreen />);
    expect(screen.getByText("That link has expired — send yourself a new one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
    expect(a.clearLinkError).toHaveBeenCalled();
  });

  it("opens sign-in (not password reset) after an expired confirmation link", () => {
    mockAuth({ linkError: { kind: "confirm-expired", message: "That confirmation link has expired or was already used." } });
    render(<LoginScreen initialMode="signup" />);
    expect(screen.getByText("That confirmation link has expired or was already used.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument();
  });

  it("uses password-manager friendly autocomplete and a show/hide toggle", () => {
    render(<LoginScreen />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("autocomplete", "current-password");
    expect(pw).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
  });

  it("shows friendly sign-in errors", async () => {
    mockAuth({ signIn: vi.fn(async () => ({ error: "Invalid login credentials" })) });
    render(<LoginScreen />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sam@company.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("don’t match");
  });
});

describe("email links", () => {
  it("never verifies a scanner-safe link until Continue is clicked", async () => {
    const a = mockAuth({ recovery: true, pendingLink: { type: "invite" }, user: null });
    render(<UpdatePasswordScreen />);
    expect(screen.getByRole("heading", { name: "Set your password" })).toBeInTheDocument();
    expect(a.verifyLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(a.verifyLink).toHaveBeenCalledTimes(1));
  });

  it("set-password form checks the confirmation and saves only matching passwords", async () => {
    const a = mockAuth({ recovery: true, passwordReason: "invite" });
    render(<UpdatePasswordScreen />);
    const pw = screen.getByLabelText("New password");
    const confirm = screen.getByLabelText("Confirm new password");
    expect(pw).toHaveAttribute("autocomplete", "new-password");
    expect(confirm).toHaveAttribute("autocomplete", "new-password");

    fireEvent.change(pw, { target: { value: "correct horse" } });
    fireEvent.change(confirm, { target: { value: "correct hors" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password and continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("don’t match");
    expect(a.updatePassword).not.toHaveBeenCalled();

    // one toggle reveals both fields
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
    expect(confirm).toHaveAttribute("type", "text");

    fireEvent.change(confirm, { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password and continue" }));
    await waitFor(() => expect(a.updatePassword).toHaveBeenCalledWith("correct horse"));
  });
});

describe("PendingApproval", () => {
  it("re-checks on demand and offers a contact route", async () => {
    mockAuth();
    h.getProfile.mockResolvedValue({ id: "u1", approved: false });
    render(<PendingApproval email="sam@company.com" onSignOut={() => {}} />);
    expect(screen.getByRole("link", { name: /@/ })).toHaveAttribute("href", expect.stringMatching(/^mailto:/));
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(await screen.findByText(/Not yet/)).toBeInTheDocument();
    expect(h.getProfile).toHaveBeenCalledWith("u1");
  });
});

describe("Sign in with Google", () => {
  beforeEach(() => { mockAuth(); try { localStorage.clear(); } catch { /* ignore */ } });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("stays hidden until VITE_ENABLE_GOOGLE is on", () => {
    render(<LoginScreen />);
    expect(screen.queryByRole("button", { name: /Google/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Signing in with Google")).not.toBeInTheDocument();
  });

  it("opens Google's account chooser, says so while it does, and explains linking", async () => {
    vi.stubEnv("VITE_ENABLE_GOOGLE", "true");
    const a = mockAuth();
    render(<LoginScreen />);
    const btn = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(btn);
    await waitFor(() => expect(a.signInWithGoogle).toHaveBeenCalledWith({ hd: null }));
    expect(screen.getByRole("button", { name: "Opening Google…" })).toBeDisabled();
    // same email, same account
    expect(screen.getByText("Signing in with Google")).toBeInTheDocument();
    expect(screen.getByText(/Same email, same account/)).toBeInTheDocument();
    expect(screen.getByText(/Invited to a team\?/)).toBeInTheDocument();
  });

  it("shows the company's accounts first, with a way to use another account", async () => {
    vi.stubEnv("VITE_ENABLE_GOOGLE", "true");
    vi.stubEnv("VITE_GOOGLE_HD", "Acme.co.uk");
    const a = mockAuth({ signInWithGoogle: vi.fn(async () => ({ error: "Unsupported provider: provider is not enabled" })) });
    render(<LoginScreen />);
    expect(screen.getByText(/Google accounts first/)).toHaveTextContent("Shows your @acme.co.uk Google accounts first.");
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(a.signInWithGoogle).toHaveBeenCalledWith({ hd: "acme.co.uk" }));
    // a provider that isn't switched on is explained beside the button, and the button works again
    expect(await screen.findByRole("alert")).toHaveTextContent("Google sign-in isn’t switched on yet");
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use another Google account" }));
    await waitFor(() => expect(a.signInWithGoogle).toHaveBeenLastCalledWith({ hd: null }));
  });

  it("never offers a hint for a free email provider, and not in password reset", () => {
    vi.stubEnv("VITE_ENABLE_GOOGLE", "true");
    vi.stubEnv("VITE_GOOGLE_HD", "gmail.com");
    render(<LoginScreen />);
    expect(screen.queryByText(/accounts first/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  });

  it("tells someone waiting after Google which account they used, and how to switch", () => {
    mockAuth({ user: { id: "u1", email: "sam@gmail.com", providers: ["google"] } });
    render(<PendingApproval email="sam@gmail.com" onSignOut={() => {}} />);
    expect(screen.getByText(/signed in with Google as/)).toHaveTextContent("You’re signed in with Google as sam@gmail.com.");
    expect(screen.getByText(/Invited with a different email\?/)).toHaveTextContent("continue with Google and choose that account");
  });

  it("keeps the email wording for a password account, and no switch hint when suspended", () => {
    mockAuth({ user: { id: "u1", email: "sam@company.com", providers: ["email"] } });
    const { unmount } = render(<PendingApproval email="sam@company.com" onSignOut={() => {}} />);
    expect(screen.getByText(/is waiting for approval/)).toHaveTextContent("Your account (sam@company.com) is waiting for approval.");
    expect(screen.getByText(/Invited with a different email\?/)).toHaveTextContent("sign in with that address");
    unmount();
    render(<PendingApproval email="sam@company.com" onSignOut={() => {}} suspended />);
    expect(screen.queryByText(/Invited with a different email/)).not.toBeInTheDocument();
  });
});

/* Root and an AI app's request: /oauth/authorize survives signing in, leaves the address bar at
   once, and shows the consent page instead of the app, whose code isn't even fetched. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  auth: { configured: true, loading: false, recovery: false, user: null as null | { id: string; email: string } },
  imported: { app: 0 },
}));
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => h.auth, AuthProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./App", () => { h.imported.app++; return { default: () => <p>The app</p> }; });
vi.mock("./auth/LoginScreen", () => ({ PublicSite: () => <p>The sign-in site</p>, UpdatePasswordScreen: () => <p>Choose a new password</p>, PendingApproval: () => null }));
vi.mock("./components/oauth/OAuthConsentPage", () => ({
  OAuthConsentPage: ({ query, email, onClose }: { query: string; email: string | null; onClose: () => void }) => (
    <div>
      <p>Consent for {query || "nothing"}</p>
      <p>{email}</p>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

import { Gate } from "./Root";
import { pendingOAuthRequest } from "./lib/oauthRequest";

const Q = "response_type=code&client_id=abc&state=s3cret";
beforeEach(() => {
  h.auth = { configured: true, loading: false, recovery: false, user: null };
  h.imported.app = 0;
  sessionStorage.clear();
});
afterEach(() => window.history.replaceState(null, "", "/"));

describe("Root and /oauth/authorize", () => {
  it("signed out: the sign-in site, with the request kept and out of the address bar", async () => {
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    render(<Gate />);
    expect(await screen.findByText("The sign-in site")).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/oauth/authorize");
    expect(pendingOAuthRequest()).toBe(Q);
    expect(h.imported.app).toBe(0);
  });

  it("signing in then opens the consent page, never the app, even coming back to the home page", async () => {
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    const { rerender } = render(<Gate />);
    await screen.findByText("The sign-in site");
    // a Google sign-in lands on the home page
    window.history.replaceState(null, "", "/");
    h.auth = { ...h.auth, user: { id: "u", email: "a@example.org" } };
    rerender(<Gate />);
    expect(await screen.findByText(`Consent for ${Q}`)).toBeInTheDocument();
    expect(screen.getByText("a@example.org")).toBeInTheDocument();
    expect(h.imported.app).toBe(0);
  });

  it("already signed in: straight to the consent page", async () => {
    h.auth.user = { id: "u", email: "a@example.org" };
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    render(<Gate />);
    expect(await screen.findByText(`Consent for ${Q}`)).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("the consent page closing forgets the request and opens the app", async () => {
    h.auth.user = { id: "u", email: "a@example.org" };
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    render(<Gate />);
    await screen.findByText(`Consent for ${Q}`);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close" })); });
    expect(await screen.findByText("The app")).toBeInTheDocument();
    expect(pendingOAuthRequest()).toBeNull();
    expect(window.location.pathname).toBe("/");
  });

  it("on the page with nothing usable, the page still opens to say so", async () => {
    h.auth.user = { id: "u", email: "a@example.org" };
    window.history.replaceState(null, "", "/oauth/authorize");
    render(<Gate />);
    expect(await screen.findByText("Consent for nothing")).toBeInTheDocument();
  });

  it("no request: the app, as before", async () => {
    h.auth.user = { id: "u", email: "a@example.org" };
    window.history.replaceState(null, "", "/today");
    render(<Gate />);
    expect(await screen.findByText("The app")).toBeInTheDocument();
  });

  it("the demo (no sign-in) shows the page too", async () => {
    h.auth = { ...h.auth, configured: false };
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    render(<Gate />);
    expect(await screen.findByText(`Consent for ${Q}`)).toBeInTheDocument();
  });

  it("a password link still comes first", async () => {
    h.auth.recovery = true;
    window.history.replaceState(null, "", `/oauth/authorize?${Q}`);
    render(<Gate />);
    expect(await screen.findByText("Choose a new password")).toBeInTheDocument();
  });
});

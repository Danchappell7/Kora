/* Root (the front door): the session first, then exactly one of the password
   screen, the sign-in site or the app — and the app's code is only fetched for
   someone who's signed in (a visitor never downloads it). */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  auth: { configured: true, loading: false, recovery: false, user: null as null | { id: string; email: string } },
  imported: { app: 0, signIn: 0 },
}));
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => h.auth, AuthProvider: ({ children }: { children: React.ReactNode }) => children }));
// stand-ins that count how often their code is fetched
vi.mock("./App", () => { h.imported.app++; return { default: () => <p>The app</p> }; });
vi.mock("./auth/LoginScreen", () => {
  h.imported.signIn++;
  return { PublicSite: () => <p>The sign-in site</p>, UpdatePasswordScreen: () => <p>Choose a new password</p>, PendingApproval: () => null, LoginScreen: () => null };
});

import { Gate } from "./Root";
import { appChunk, likelySignedIn } from "./entryChunks";

beforeEach(() => { h.auth = { configured: true, loading: false, recovery: false, user: null }; });

describe("Root's gate", () => {
  it("shows the app's loading silhouette while the session is restored, fetching nothing yet", () => {
    h.auth.loading = true;
    render(<Gate />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your workspace");
    expect(h.imported).toEqual({ app: 0, signIn: 0 });
  });

  it("a visitor gets the sign-in site, and never the app's code", async () => {
    render(<Gate />);
    expect(await screen.findByText("The sign-in site")).toBeInTheDocument();
    expect(h.imported.app).toBe(0);
    expect(appChunk.loaded).toBeNull();
  });

  it("a password link shows its screen (before the session or the app)", async () => {
    h.auth.recovery = true;
    render(<Gate />);
    expect(await screen.findByText("Choose a new password")).toBeInTheDocument();
    expect(h.imported.app).toBe(0);
  });

  it("someone signed in gets the app (its loading silhouette while the code arrives)", async () => {
    h.auth.user = { id: "u1", email: "sana@acme.io" };
    render(<Gate />);
    expect(await screen.findByText("The app")).toBeInTheDocument();
    expect(h.imported.app).toBe(1);
  });

  it("demo mode (no backend) goes straight to the app", async () => {
    h.auth = { configured: false, loading: false, recovery: false, user: null };
    render(<Gate />);
    expect(await screen.findByText("The app")).toBeInTheDocument();
  });
});

describe("likelySignedIn (which code main.tsx asks for first)", () => {
  const storage = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null });
  it("is the app for a stored session, an OAuth return, or demo mode", () => {
    expect(likelySignedIn({ configured: true, storage: storage(["kanbo-theme", "sb-htnchiljplrnjkwimgla-auth-token"]) })).toBe(true);
    expect(likelySignedIn({ configured: true, storage: storage([]), href: "https://www.kanbo.co.uk/?code=abc" })).toBe(true);
    expect(likelySignedIn({ configured: true, storage: storage([]), href: "https://www.kanbo.co.uk/#access_token=x&type=bearer" })).toBe(true);
    expect(likelySignedIn({ configured: false, storage: null })).toBe(true);
  });
  it("is the sign-in site for anyone else (a code-verifier alone isn't a session)", () => {
    expect(likelySignedIn({ configured: true, storage: storage(["sb-x-auth-token-code-verifier"]), href: "https://www.kanbo.co.uk/" })).toBe(false);
    expect(likelySignedIn({ configured: true, storage: null, href: "https://www.kanbo.co.uk/today" })).toBe(false);
    const blocked = { get length(): number { throw new Error("blocked"); }, key: () => null };
    expect(likelySignedIn({ configured: true, storage: blocked })).toBe(false);
  });
});

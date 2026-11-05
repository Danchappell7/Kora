/* /oauth/authorize: "Allow <app> to use your Kanbo?" Demo mode, with lib/mcpOAuth's calls stubbed where a test needs them. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const flags = vi.hoisted(() => ({ configured: true }));
vi.mock("../../lib/supabase", async (orig) => ({ ...(await orig<object>()), get isSupabaseConfigured() { return flags.configured; } }));

import { OAuthConsentPage } from "./OAuthConsentPage";
import * as lib from "../../lib/mcpOAuth";
import { pendingOAuthRequest, rememberOAuthRequest } from "../../lib/oauthRequest";

const CHALLENGE = "a".repeat(43);
const query = (o: Record<string, string> = {}, drop: string[] = []) => {
  const sp = new URLSearchParams({
    response_type: "code", client_id: "kmcp_client_abc", redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st-1", scope: "kanbo.read kanbo.write offline_access", resource: "https://www.kanbo.co.uk/mcp", ...o,
  });
  for (const d of drop) sp.delete(d);
  return sp.toString();
};
const client = (o: Partial<lib.PreparedClient> = {}): lib.PreparedClient => ({ name: "Claude", kind: "cimd", clientHost: "claude.ai", redirectHost: "claude.ai", loopback: false, ...o });
const WS = [{ id: "ws-1", name: "Foundry" }, { id: "ws-2", name: "Side project" }];

function setup(q = query(), o: { prepared?: lib.PrepareResult; workspaces?: lib.ConsentWorkspace[] } = {}) {
  const prepare = vi.spyOn(lib, "prepareClient").mockResolvedValue(o.prepared ?? { ok: true, client: client() });
  vi.spyOn(lib, "consentWorkspaces").mockResolvedValue(o.workspaces ?? WS);
  const approve = vi.spyOn(lib, "approveConnection").mockResolvedValue("the-code");
  const navigate = vi.fn();
  const onClose = vi.fn();
  render(<OAuthConsentPage query={q} email="daniel@example.org" onClose={onClose} navigate={navigate} />);
  return { prepare, approve, navigate, onClose };
}
const asked = () => screen.findByRole("heading", { level: 1, name: /Allow .* to use your Kanbo\?/ });

beforeEach(() => { flags.configured = true; vi.restoreAllMocks(); });

describe("asking", () => {
  it("says who's asking, where you'd go back to, and that the name is the app's own", async () => {
    const { prepare } = setup();
    await asked();
    expect(prepare).toHaveBeenCalledWith("kmcp_client_abc", "https://claude.ai/api/mcp/auth_callback");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Allow Claude to use your Kanbo?");
    expect(screen.getByText("Sends you back to").nextElementSibling).toHaveTextContent("claude.ai");
    expect(screen.getByText("Published by").nextElementSibling).toHaveTextContent("claude.ai");
    expect(screen.getByText("daniel@example.org")).toBeInTheDocument();
    expect(screen.getByText(/is the name the app gave itself/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("offers read and change or read only, and all workspaces or one", async () => {
    setup();
    await asked();
    expect(screen.getByRole("group", { name: "What it can do" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Read and change/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Read only/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /All my workspaces/ })).toBeChecked();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /One workspace/ }));
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveValue("ws-1");
  });

  it("an app that only asked to read can't be given more", async () => {
    setup(query({ scope: "kanbo.read" }));
    await asked();
    expect(screen.queryByRole("radio", { name: /Read and change/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();
    expect(screen.getByText(/This app only asked to read/)).toBeInTheDocument();
  });

  it("with no workspaces, there's only the one choice", async () => {
    setup(query(), { workspaces: [] });
    await asked();
    expect(screen.queryByRole("radio", { name: /One workspace/ })).toBeNull();
  });

  it("warns when it goes back to this computer", async () => {
    setup(query({ redirect_uri: "http://localhost:8787/callback" }), { prepared: { ok: true, client: client({ redirectHost: "localhost", loopback: true, clientHost: null, kind: "dcr", name: "Local thing" }) } });
    await asked();
    expect(screen.getByRole("note")).toHaveTextContent(/runs on this computer/);
    expect(screen.queryByText("Published by")).toBeNull();
  });

  it("a hostile name is just text", async () => {
    setup(query(), { prepared: { ok: true, client: client({ name: "<img src=x onerror=alert(1)>" }) } });
    await asked();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Allow <img src=x onerror=alert(1)> to use your Kanbo?");
  });
});

describe("Allow", () => {
  it("approves through the RPC and goes back with the code, the state and iss", async () => {
    const { approve, navigate } = setup();
    await asked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const req = approve.mock.calls[0][0];
    expect(req).toMatchObject({ clientId: "kmcp_client_abc", codeChallenge: CHALLENGE, resource: "https://www.kanbo.co.uk/mcp", state: "st-1" });
    expect(approve.mock.calls[0].slice(1)).toEqual(["write", null]);
    const u = new URL(navigate.mock.calls[0][0]);
    expect(u.origin + u.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(u.searchParams.get("code")).toBe("the-code");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("iss")).toBe("https://www.kanbo.co.uk");
    expect(await screen.findByRole("heading", { name: "All done" })).toBeInTheDocument();
  });

  it("passes on read only and the one workspace", async () => {
    const { approve } = setup();
    await asked();
    fireEvent.click(screen.getByRole("radio", { name: /Read only/ }));
    fireEvent.click(screen.getByRole("radio", { name: /One workspace/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "ws-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(approve.mock.calls[0].slice(1)).toEqual(["read", "ws-2"]);
  });

  it("a refusal stays on the page, in plain words, and doesn't redirect", async () => {
    const { approve, navigate } = setup();
    approve.mockRejectedValue(new lib.ApproveError("rate_limited", "Too many tries. Wait a minute and try again."));
    await asked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many tries");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
  });

  it("in the demo nothing is sent anywhere", async () => {
    flags.configured = false;
    const { navigate } = setup();
    await asked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("heading", { name: "This is the demo" })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("once it's left for the app", () => {
  it("this tab forgets the request, so it won't ask again", async () => {
    for (const button of ["Allow", "Cancel"]) {
      rememberOAuthRequest("client_id=x");
      const { navigate } = setup();
      await asked();
      fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(pendingOAuthRequest(), button).toBeNull();
      document.body.innerHTML = "";
    }
  });
  it("a refused Allow keeps it, to try again", async () => {
    rememberOAuthRequest("client_id=x");
    const { approve } = setup();
    approve.mockRejectedValue(new lib.ApproveError("rate_limited", "Too many tries."));
    await asked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText("Too many tries.");
    expect(pendingOAuthRequest()).toBe("client_id=x");
    sessionStorage.clear();
  });
});

describe("Cancel", () => {
  it("goes back with access_denied, the state and iss", async () => {
    const { navigate, approve } = setup();
    await asked();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const u = new URL(navigate.mock.calls[0][0]);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("iss")).toBe("https://www.kanbo.co.uk");
    expect(approve).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Nothing was connected" })).toBeInTheDocument();
  });
});

describe("errors here, never a redirect", () => {
  it.each([
    ["no client", query({}, ["client_id"]), /doesn't say which app/],
    ["no redirect address", query({}, ["redirect_uri"]), /address Kanbo won't use/],
    ["javascript:", query({ redirect_uri: "javascript:alert(1)" }), /address Kanbo won't use/],
    ["data:", query({ redirect_uri: "data:text/html,x" }), /address Kanbo won't use/],
    ["http elsewhere", query({ redirect_uri: "http://evil.example/cb" }), /address Kanbo won't use/],
    ["nothing at all", "", /doesn't say which app/],
  ])("%s", async (_w, q, re) => {
    const { navigate, prepare } = setup(q);
    expect(await screen.findByRole("heading", { name: "This link isn't complete" })).toBeInTheDocument();
    expect(screen.getByText(re)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("an app or address the server refuses stops here too, even with other mistakes in the request", async () => {
    for (const q of [query(), query({ response_type: "token" })]) {
      const { navigate, onClose } = setup(q, { prepared: { ok: false, reason: "refused", message: "This app asked to send you back to an address it hasn't registered, so Kanbo stopped here." } });
      expect(await screen.findByRole("heading", { name: "Kanbo can't connect this app" })).toBeInTheDocument();
      expect(screen.getByText(/hasn't registered/)).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Back to Kanbo" }));
      expect(onClose).toHaveBeenCalled();
      document.body.innerHTML = "";
    }
  });

  it("not switched on yet says so", async () => {
    setup(query(), { prepared: { ok: false, reason: "not_ready", message: lib.MCP_COPY.notReady } });
    expect(await screen.findByRole("heading", { name: "Not switched on yet" })).toBeInTheDocument();
  });

  it("can be tried again when Kanbo couldn't check", async () => {
    const { prepare } = setup(query(), { prepared: { ok: false, reason: "unavailable", message: "Later." } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Later.");
    prepare.mockResolvedValue({ ok: true, client: client() });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await asked();
  });
});

describe("other mistakes go back to the app, once its address is checked", () => {
  it.each([
    ["a wrong response_type", { response_type: "token" }, "unsupported_response_type"],
    ["PKCE plain", { code_challenge_method: "plain" }, "invalid_request"],
    ["another server", { resource: "https://evil.example/mcp" }, "invalid_target"],
  ])("%s", async (_w, o, error) => {
    const { navigate, prepare } = setup(query(o as Record<string, string>));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalled();
    const u = new URL(navigate.mock.calls[0][0]);
    expect(u.origin).toBe("https://claude.ai");
    expect(u.searchParams.get("error")).toBe(error);
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("iss")).toBe("https://www.kanbo.co.uk");
  });
});

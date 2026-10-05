/* Settings › Developers in demo mode: the example keys, making a key (shown
   once, copyable, then only its prefix), team keys for owners/admins,
   revoking with a confirmation, and the helpers that word the dates. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DevelopersPanel, fmtExpiry, fmtKeyDate, fmtLastUsed, type DevWorkspace } from "./DevelopersPanel";
import { API_KEY_COPY, API_KEY_RE, resetDemoApiKeys } from "../../lib/apiKeys";

const WS: DevWorkspace[] = [
  { id: "11111111-2222-4333-8444-555555555555", name: "Foundrise", role: "owner" },
  { id: "22222222-2222-4333-8444-555555555555", name: "Side gig", role: "member" },
];
const DAY = 86_400_000;

beforeEach(() => {
  resetDemoApiKeys();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

const keyList = () => screen.findByRole("list", { name: "Your API keys" });

describe("DevelopersPanel (demo)", () => {
  it("lists the example keys with prefix, access, scope, last use and expiry", async () => {
    render(<DevelopersPanel workspaces={WS} currentWorkspaceId={null} onOpenDocs={() => {}} />);
    const list = await keyList();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector(".kdev-key-name")?.textContent)).toEqual(["Zapier", "Reporting script", "Old CI token"]);
    const zapier = rows[0];
    expect(zapier).toHaveTextContent("kanbo_pk_8fQz…");
    expect(zapier).toHaveTextContent("Read-only");
    expect(zapier).toHaveTextContent("Personal");
    expect(zapier).toHaveTextContent("Used 3 days ago");
    expect(zapier).toHaveTextContent("No expiry");
    expect(rows[1]).toHaveTextContent("Read & write");
    expect(rows[1]).toHaveTextContent(/Expires in 1[12] days/);
    expect(rows[2]).toHaveTextContent("Revoked");
    expect(within(rows[2]).queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.getByText(/this is the demo/i)).toBeInTheDocument();
  });

  it("opens the API reference", async () => {
    const onOpenDocs = vi.fn();
    render(<DevelopersPanel workspaces={WS} currentWorkspaceId={null} onOpenDocs={onOpenDocs} />);
    fireEvent.click(screen.getByRole("button", { name: "API reference" }));
    expect(onOpenDocs).toHaveBeenCalled();
  });

  it("makes a key: shown once with a warning and copy, then only its prefix", async () => {
    render(<DevelopersPanel workspaces={WS} currentWorkspaceId={null} />);
    await keyList();
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    const form = screen.getByRole("form", { name: "Create an API key" });
    // a name is required
    fireEvent.click(within(form).getByRole("button", { name: "Create key" }));
    expect(within(form).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Nightly export" } });
    fireEvent.click(within(form).getByRole("radio", { name: /Read & write/ }));
    fireEvent.change(within(form).getByLabelText("Expires"), { target: { value: "90" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create key" }));

    const field = (await screen.findByLabelText("Your new API key")) as HTMLInputElement;
    const key = field.value;
    expect(key).toMatch(API_KEY_RE);
    expect(key.startsWith("kanbo_sk_")).toBe(true);
    expect(screen.getByText(API_KEY_COPY.shownOnce)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "“Nightly export” is ready" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(field));

    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(key));
    expect(await screen.findByRole("button", { name: "Key copied" })).toBeInTheDocument();

    const list = await keyList();
    await waitFor(() => expect(within(list).getByText("Nightly export")).toBeInTheDocument());
    const row = within(list).getByText("Nightly export").closest("li")!;
    expect(row).toHaveTextContent(`${key.slice(0, 13)}…`);
    expect(row).toHaveTextContent(/Expires/);

    fireEvent.click(screen.getByRole("button", { name: /Done, I've stored it safely/ }));
    expect(screen.queryByLabelText("Your new API key")).toBeNull();
    expect(document.body.textContent).not.toContain(key);
  });

  it("team keys only for workspaces you own or administer", async () => {
    render(<DevelopersPanel workspaces={WS} currentWorkspaceId={WS[1].id} />);
    await keyList();
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    const scope = screen.getByLabelText("Works in") as HTMLSelectElement;
    const options = Array.from(scope.options).map((o) => o.textContent);
    expect(options).toEqual(["Everywhere you work (personal key)", "Only Foundrise (team key)"]);
    expect(scope.value).toBe("personal"); // a member of Side gig: no team key there
    fireEvent.change(scope, { target: { value: WS[0].id } });
    expect(screen.getByText(/only inside Foundrise/)).toBeInTheDocument();
  });

  it("members and guests see no team options", async () => {
    render(<DevelopersPanel workspaces={[WS[1]]} currentWorkspaceId={WS[1].id} />);
    await keyList();
    expect(screen.queryByRole("button", { name: "Team keys" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(Array.from((screen.getByLabelText("Works in") as HTMLSelectElement).options)).toHaveLength(1);
    expect(screen.getByText(/Team keys are for workspace owners and admins/)).toBeInTheDocument();
  });

  it("owners and admins see everyone's team keys and can revoke them", async () => {
    render(<DevelopersPanel workspaces={WS} currentWorkspaceId={WS[0].id} />);
    await keyList();
    fireEvent.click(screen.getByRole("button", { name: "Team keys" }));
    const list = await screen.findByRole("list", { name: "Team keys" });
    const row = within(list).getByText("Warehouse export").closest("li")!;
    expect(row).toHaveTextContent("by Priya Shah");
    expect(row).toHaveTextContent("Team · Foundrise");
    expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
  });

  it("revokes after a confirmation; cancel keeps it", async () => {
    render(<DevelopersPanel workspaces={WS} currentWorkspaceId={null} />);
    const list = await keyList();
    const zapier = () => within(list).getByText("Zapier").closest("li")!;
    fireEvent.click(within(zapier()).getByRole("button", { name: "Revoke" }));
    expect(within(zapier()).getByText("Revoke “Zapier”?")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Cancel"));
    fireEvent.click(within(zapier()).getByRole("button", { name: "Cancel" }));
    expect(within(zapier()).queryByText("Revoke “Zapier”?")).toBeNull();

    fireEvent.click(within(zapier()).getByRole("button", { name: "Revoke" }));
    await act(async () => { fireEvent.click(within(zapier()).getByRole("button", { name: "Revoke key" })); });
    await waitFor(() => expect(zapier()).toHaveTextContent("Revoked"));
    expect(await screen.findByText(/Revoked “Zapier”/)).toBeInTheDocument();
    expect(within(zapier()).queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});

describe("wording", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("last used", () => {
    expect(fmtLastUsed(null, now)).toBe("Never used");
    expect(fmtLastUsed(new Date(now - 30_000).toISOString(), now)).toBe("Used just now");
    expect(fmtLastUsed(new Date(now - 5 * 60_000).toISOString(), now)).toBe("Used 5 minutes ago");
    expect(fmtLastUsed(new Date(now - 3_600_000).toISOString(), now)).toBe("Used 1 hour ago");
    expect(fmtLastUsed(new Date(now - DAY - 1000).toISOString(), now)).toBe("Used yesterday");
    expect(fmtLastUsed(new Date(now - 3 * DAY).toISOString(), now)).toBe("Used 3 days ago");
    expect(fmtLastUsed("2026-08-05T09:00:00Z", now)).toBe("Used on 5 Aug 2026");
  });
  it("expiry", () => {
    expect(fmtExpiry({ expiresAt: null, status: "active", revokedAt: null }, now)).toEqual({ text: "No expiry", soon: false });
    expect(fmtExpiry({ expiresAt: new Date(now + 12 * DAY).toISOString(), status: "active", revokedAt: null }, now)).toEqual({ text: "Expires in 12 days", soon: true });
    expect(fmtExpiry({ expiresAt: "2027-03-01T00:00:00Z", status: "active", revokedAt: null }, now).text).toBe("Expires 1 Mar 2027");
    expect(fmtExpiry({ expiresAt: "2026-10-01T00:00:00Z", status: "expired", revokedAt: null }, now).text).toBe("Expired 1 Oct 2026");
    expect(fmtExpiry({ expiresAt: null, status: "revoked", revokedAt: "2026-09-30T10:00:00Z" }, now).text).toBe(`Revoked ${fmtKeyDate("2026-09-30T10:00:00Z")}`);
    expect(fmtKeyDate("2026-09-30T10:00:00Z")).toMatch(/^30 Sept? 2026$/);
  });
});

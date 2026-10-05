/* Settings › Developers when its code can't be fetched (offline, or a tab left
   open across a new release): the section says so; Settings keeps working. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { AuthProvider } from "../auth/AuthProvider";

vi.mock("./settings/DevelopersSection", () => { throw new Error("Failed to fetch dynamically imported module"); });

describe("Settings › Developers, code not loaded", () => {
  it("explains and offers a reload instead of breaking the app", async () => {
    render(
      <AuthProvider>
        <SettingsModal open onClose={vi.fn()} initial={{ firstName: "Ada", lastName: "Lovelace", pronouns: "", avatarUrl: null }}
          email="ada@acme.co.uk" color="oklch(0.6 0.2 264)" onUpload={vi.fn(async () => "blob:demo")} onSave={vi.fn(async () => {})}
          onExport={vi.fn()} onDeleteAccount={vi.fn(async () => {})}
          developers={{ workspaces: [], currentWorkspaceId: null }} />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /^Developers/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This part of Settings couldn't load.");
    expect(screen.getByRole("button", { name: "Reload Kanbo" })).toBeInTheDocument();
    // the rest of Settings still works
    fireEvent.click(screen.getByRole("tab", { name: /^Appearance/ }));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
  });
});
